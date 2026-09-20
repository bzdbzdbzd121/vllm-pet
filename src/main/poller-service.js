/**
 * poller-service.js — 主进程轮询推理服务（vLLM / SGLang），推导状态并推送 StatusSnapshot。
 *
 * 采集链路（依次尝试）：
 *   1. GET <apiBase><healthPath>（失败则 GET <apiBase>/v1/models 兜底判活）
 *   2. GET <apiBase><metricsPath> 解析 Prometheus 指标 —— vllm:* / sglang:* 自动识别
 *   3. 读不到并发指标时（典型：SGLang 没加 --enable-metrics）兜底
 *      GET <apiBase>/v1/loads?include=core（SGLang ≥ 0.5.8 的负载接口，只取 core 段）
 *   → deriveState
 *
 * 配置 backend 可强制指定引擎：'auto'（默认，自动识别）/ 'vllm' / 'sglang'。
 * 只有 auto 与 sglang 才走第 3 步（vLLM 没有该接口；auto 下探测失败会退避 60s）。
 */
import { parsePrometheusMetrics, parseLoadsResponse, deriveState, sampleGenerationRate, sampleActivity, BACKENDS } from '../shared/status-core.js'

const FETCH_TIMEOUT_MS = 4000
/** SGLang 负载接口（/get_load 已废弃；不带 include 会返回全部段落） */
const LOADS_PATH = '/v1/loads?include=core'
/** 探测到服务不支持 /v1/loads 后，多久再试一次（服务可能中途重启为 SGLang） */
const LOADS_RETRY_MS = 60_000
/** 健康但读不到负载指标时给 UI 的短提示（设置面板里有详细说明） */
const NO_LOAD_HINT = '未读到负载指标'

export class PollerService {
  /**
   * @param {{ getConfig: () => object, onStatus: (snap: object) => void }} opts
   */
  constructor({ getConfig, onStatus }) {
    this.getConfig = getConfig
    this.onStatus = onStatus
    this._timer = 0
    this._running = false
    this._everConnected = false
    this._lastGenSample = null // { value, at, source }：上一次生成 token counter 采样
    this._lastActivity = null // { prefillTokens, decodeTokens, usedTokens, at }：上一次活动采样
    this._loadsUnsupported = false // 服务不支持 /v1/loads（探过一次就不再每轮都打）
    this._loadsCheckedAt = 0
  }

  start() {
    if (this._running) return
    this._running = true
    this._tick()
  }

  stop() {
    this._running = false
    clearTimeout(this._timer)
  }

  restart() {
    this.stop()
    // 配置可能换了服务地址/引擎，重新探测负载接口
    this._loadsUnsupported = false
    this._lastGenSample = null
    this._lastActivity = null
    this.start()
  }

  async _tick() {
    if (!this._running) return
    const config = this.getConfig()
    let snap
    if (!config.apiBase) {
      snap = this._snapshot({ state: 'connecting', error: '尚未配置服务地址，右键宠物打开设置' })
    } else {
      try {
        snap = await this._poll(config)
      } catch (err) {
        snap = this._snapshot({
          state: this._everConnected ? 'offline' : 'connecting',
          error: String(err?.message || err)
        })
      }
    }
    this.onStatus(snap)
    if (this._running) {
      this._timer = setTimeout(() => this._tick(), Math.max(500, config.pollIntervalMs || 2000))
    }
  }

  async _poll(config) {
    const base = config.apiBase.replace(/\/+$/, '')
    const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
    const startedAt = Date.now()
    const backend = BACKENDS.includes(config.backend) ? config.backend : 'auto'

    // 1. 健康检查（/health 失败时用 /v1/models 兜底）
    const netErrs = []
    let healthOk = await tryHealth(base + config.healthPath, headers, netErrs)
    let models = []
    if (!healthOk) {
      const res = await tryFetch(base + '/v1/models', headers, netErrs)
      healthOk = !!res?.ok
      if (res?.ok) {
        const data = await res.json().catch(() => null)
        models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
      }
    }

    // 2. 指标（老版本没有 /metrics、SGLang 未开 --enable-metrics 时读不到）
    let metrics = null
    if (healthOk) {
      const res = await tryFetch(base + config.metricsPath, headers)
      if (res?.ok) metrics = parsePrometheusMetrics(await res.text())
    }

    // 3. 兜底：SGLang 负载接口（vLLM 没有，指定 vllm 模式时跳过）
    let load = metrics
    let loadSource = metrics?.hasConcurrency ? 'metrics' : 'none'
    if (healthOk && !metrics?.hasConcurrency && backend !== 'vllm') {
      const fallback = await this._fetchLoads(base, headers)
      if (fallback) {
        load = fallback
        loadSource = 'loads'
      }
    }

    if (healthOk) this._everConnected = true

    // 活动采样：SGLang 的并发 gauge 看不到正在 prefill 的请求（见 status-core 注释）
    const activity = sampleActivity(load, this._lastActivity)
    this._lastActivity = activity.sample

    const { state, intensity } = deriveState({ healthOk, metrics: load, active: activity.active }, config.thresholds)

    // 生成吞吐：优先 SGLang 每次迭代累加的 counter，其次累计 counter 求差，最后用服务自报吞吐
    const { tokensPerSec, sample } = sampleGenerationRate(load, this._lastGenSample)
    this._lastGenSample = sample

    return this._snapshot({
      state: healthOk ? state : this._everConnected ? 'offline' : 'connecting',
      intensity,
      backend: load?.backend ?? null,
      loadSource,
      prefillActive: activity.prefillActive,
      running: load?.running ?? 0,
      waiting: load?.waiting ?? 0,
      cacheUsage: load?.cacheUsage ?? null,
      tokensPerSec,
      latencyMs: Date.now() - startedAt,
      models,
      hint: healthOk && loadSource === 'none' ? NO_LOAD_HINT : null,
      error: healthOk ? null : describeNetError(netErrs[0])
    })
  }

  /** GET /v1/loads?include=core；不支持的服务探一次后退避，避免每轮都打 */
  async _fetchLoads(base, headers) {
    if (this._loadsUnsupported && Date.now() - this._loadsCheckedAt < LOADS_RETRY_MS) return null
    this._loadsCheckedAt = Date.now()
    const res = await tryFetch(base + LOADS_PATH, headers)
    const parsed = res?.ok ? parseLoadsResponse(await res.json().catch(() => null)) : null
    this._loadsUnsupported = !parsed
    return parsed
  }

  _snapshot(patch) {
    return {
      state: 'connecting',
      intensity: 0,
      backend: null,
      loadSource: 'none',
      prefillActive: false,
      running: 0,
      waiting: 0,
      cacheUsage: null,
      tokensPerSec: null,
      latencyMs: null,
      models: [],
      hint: null,
      error: null,
      updatedAt: Date.now(),
      ...patch
    }
  }
}

async function tryHealth(url, headers, errs) {
  const res = await tryFetch(url, headers, errs)
  return !!res?.ok
}

async function tryFetch(url, headers, errs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    // connection: close —— 每次全新连接，避免睡眠唤醒/网络切换后复用已死的 keep-alive 连接
    return await fetch(url, { headers: { connection: 'close', ...headers }, signal: ctrl.signal })
  } catch (err) {
    errs?.push(err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 把底层网络错误翻译成一句可展示的排查提示（undici 的真实原因在 err.cause.code） */
export function describeNetError(err) {
  const code = err?.cause?.code || err?.code || ''
  if (code === 'EPERM') return '无本地网络权限（系统设置→隐私与安全性→本地网络，允许小V）'
  if (code === 'ECONNREFUSED') return '连接被拒绝（服务未启动或端口不对）'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '地址无法解析（检查服务地址）'
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被重置'
  if (code === 'ETIMEDOUT' || err?.name === 'TimeoutError' || err?.name === 'AbortError') return '连接超时'
  return '服务不可达'
}