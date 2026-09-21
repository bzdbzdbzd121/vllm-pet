/**
 * poller-service.js — 主进程轮询推理服务（vLLM / SGLang），推导状态并推送 StatusSnapshot。
 *
 * 采集链路（依次尝试）：
 *   1. GET <apiBase><healthPath>（失败则 GET <apiBase>/v1/models 兜底判活）
 *   2. GET <apiBase><metricsPath> 解析 Prometheus 指标 —— vllm:* / sglang:* 自动识别
 *   3. SGLang：GET /v1/loads?include=core 取**实时**并发数（SGLang ≥ 0.5.8）
 *      —— /metrics 的 gauge 是推送快照，空闲后会冻结（上游 PR #26495），所以计数以它为准
 *   → deriveState
 *
 * 配置 backend 可强制指定引擎：'auto'（默认，自动识别）/ 'vllm' / 'sglang'。
 * 只有 auto 与 sglang 才走第 3 步（vLLM 没有该接口；auto 下探测失败会退避 60s）。
 */
import { parsePrometheusMetrics, parseLoadsResponse, mergeLoads, deriveState, sampleGenerationRate, sampleActivity, BACKENDS } from '../shared/status-core.js'

const FETCH_TIMEOUT_MS = 4000
/** SGLang 负载接口（/get_load 已废弃；不带 include 会返回全部段落） */
const LOADS_PATH = '/v1/loads?include=core'
/**
 * SGLang 的就绪接口（非生成式，只看 server_status）。
 * ⚠️ 判活绝不能拿 `/health` 打头：SGLang 的 `/health` 默认**会真的生成 1 个 token**
 * （`SGLANG_ENABLE_HEALTH_ENDPOINT_GENERATION` 默认 True，§4.11），而且那个请求会短暂出现在
 * running_batch / waiting_queue 里被 `/v1/loads` 数成"正在运行"——于是空闲时永远显示
 * "推理中 ×1 · 0.5 tok/s"（每 2s 轮询一次，正好 1 token = 0.5 tok/s）。
 * 所以判活按"非生成式优先"依次尝试：/ready → /v1/models → healthPath。
 */
const READY_PATH = '/ready'
const MODELS_PATH = '/v1/models'
const DEFAULT_HEALTH_PATH = '/health'
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
    this._readyUnsupported = false // 服务没有 /ready（vLLM / 老版本 SGLang）→ 试下一个
    this._modelsUnsupported = false // 服务没有 /v1/models → 最后才用会触发生成的 healthPath
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
    this._readyUnsupported = false
    this._modelsUnsupported = false
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

    // 1. 判活：非生成式优先（/ready → /v1/models → healthPath），失败时再用 /v1/models 兜底
    const netErrs = []
    const health = await this._checkHealth(base, headers, netErrs, config.healthPath)
    let healthOk = health.ok
    let models = health.models
    if (!healthOk && !health.viaModels) {
      const res = await tryFetch(base + MODELS_PATH, headers, netErrs)
      healthOk = !!res?.ok
      if (healthOk) models = await readModelIds(res)
    }

    // 2. 指标：counter（tok/s、活动信号）与 gauge
    let metrics = null
    if (healthOk) {
      const res = await tryFetch(base + config.metricsPath, headers)
      if (res?.ok) metrics = parsePrometheusMetrics(await res.text())
    }

    // 3. SGLang 的实时负载接口：/metrics 的 gauge 是推送快照，空闲后会冻结在最后一批的数值上
    //    （上游 PR #26495 实测卡 30s）→ 计数优先用现算的 /v1/loads，counter 仍用 /metrics。
    //    vLLM 没有这个接口，直接跳过。
    let live = null
    if (healthOk && backend !== 'vllm' && metrics?.backend !== 'vllm') {
      live = await this._fetchLoads(base, headers)
    }

    const load = mergeLoads(live, metrics)
    const loadSource = live ? 'loads' : metrics?.hasConcurrency ? 'metrics' : 'none'

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

  /**
   * 判活。默认 healthPath 时按"非生成式优先"依次尝试 `/ready` → `/v1/models` → `healthPath`。
   *
   * `/health` 必须放最后：SGLang 的 `/health` 默认会真生成 1 个 token，而那个请求会被我们紧接着
   * 请求的 `/v1/loads` 数成"正在运行"（见文件头注释与 §4.11）。
   * 404/405 = 没有该端点（记住，不再重复探）；401/403 = 端点在但要鉴权（试下一个，
   * 保留以前"密钥不对时 /health 仍能判活"的行为）；其余响应就以它为准（200 就绪 / 503 启动中）。
   * 用户自定义了 healthPath 就完全尊重用户配置。
   *
   * @returns {Promise<{ ok: boolean, models: string[], viaModels: boolean }>}
   */
  async _checkHealth(base, headers, netErrs, healthPath) {
    if (healthPath !== DEFAULT_HEALTH_PATH) {
      return { ok: await tryHealth(base + healthPath, headers, netErrs), models: [], viaModels: false }
    }
    for (const [path, flag] of [[READY_PATH, '_readyUnsupported'], [MODELS_PATH, '_modelsUnsupported']]) {
      if (this[flag]) continue
      const res = await tryFetch(base + path, headers, netErrs)
      if (!res) continue
      if (res.status === 404 || res.status === 405) {
        this[flag] = true
        continue
      }
      if (res.status === 401 || res.status === 403) continue
      if (path === MODELS_PATH) return { ok: res.ok, models: await readModelIds(res), viaModels: true }
      return { ok: res.ok, models: [], viaModels: false }
    }
    return { ok: await tryHealth(base + healthPath, headers, netErrs), models: [], viaModels: false }
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

/** 从 /v1/models 响应里取模型名（拿不到就空数组） */
async function readModelIds(res) {
  const data = await res.json().catch(() => null)
  return Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
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