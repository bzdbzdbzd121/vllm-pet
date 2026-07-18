/**
 * poller-service.js — 主进程轮询 vLLM 服务，推导状态并推送 StatusSnapshot。
 *
 * 流程：GET <apiBase><healthPath>（失败则 GET <apiBase>/v1/models 兜底判活）
 *      → GET <apiBase><metricsPath> 解析 vllm 指标 → deriveState
 */
import { parsePrometheusMetrics, deriveState } from '../shared/status-core.js'

const FETCH_TIMEOUT_MS = 4000

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

    // 1. 健康检查（/health 失败时用 /v1/models 兜底）
    let healthOk = await tryHealth(base + config.healthPath, headers)
    let models = []
    if (!healthOk) {
      const res = await tryFetch(base + '/v1/models', headers)
      healthOk = !!res?.ok
      if (res?.ok) {
        const data = await res.json().catch(() => null)
        models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
      }
    }

    // 2. 指标（老版本没有 /metrics 时降级为仅存活检测）
    let metrics = null
    if (healthOk) {
      const res = await tryFetch(base + config.metricsPath, headers)
      if (res?.ok) metrics = parsePrometheusMetrics(await res.text())
    }

    if (healthOk) this._everConnected = true
    const { state, intensity } = deriveState({ healthOk, metrics }, config.thresholds)
    return this._snapshot({
      state: healthOk ? state : this._everConnected ? 'offline' : 'connecting',
      intensity,
      running: metrics?.running ?? 0,
      waiting: metrics?.waiting ?? 0,
      cacheUsage: metrics?.cacheUsage ?? null,
      latencyMs: Date.now() - startedAt,
      models,
      error: healthOk ? null : '服务不可达'
    })
  }

  _snapshot(patch) {
    return {
      state: 'connecting',
      intensity: 0,
      running: 0,
      waiting: 0,
      cacheUsage: null,
      latencyMs: null,
      models: [],
      error: null,
      updatedAt: Date.now(),
      ...patch
    }
  }
}

async function tryHealth(url, headers) {
  const res = await tryFetch(url, headers)
  return !!res?.ok
}

async function tryFetch(url, headers) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
