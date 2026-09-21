/**
 * providers.js — 状态来源抽象。
 *   IpcStatusProvider  — Electron 桌面窗口（主进程轮询，经 preload 桥 window.vllmPet）
 *   MockStatusProvider — 浏览器预览：手动推送状态 + localStorage 模拟配置
 *   LiveFetchProvider  — 浏览器"真实直连"：直接 fetch vLLM（受 CORS 限制，仅调试用）
 */
import { parsePrometheusMetrics, parseLoadsResponse, mergeLoads, deriveState, sampleGenerationRate, sampleActivity, DEFAULT_THRESHOLDS } from '../../shared/status-core.js'

export const DEFAULT_CONFIG = Object.freeze({
  apiBase: '',
  apiKey: '',
  backend: 'auto', // 'auto' | 'vllm' | 'sglang'
  pollIntervalMs: 2000,
  metricsPath: '/metrics',
  healthPath: '/health',
  thresholds: { ...DEFAULT_THRESHOLDS },
  stateMap: { light: 'busy-1', medium: 'busy-2', heavy: 'busy-3' },
  showStatus: true,
  showKvCache: true,
  statusFontSize: 11,
  skin: 'default-robot',
  idleSleepMinutes: 10,
  update: { autoCheck: true },
  window: { alwaysOnTop: true, clickThrough: false, scale: 1, opacity: 1, x: null, y: null }
})

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/* ---------------- Electron IPC ---------------- */
export class IpcStatusProvider {
  constructor(bridge = window.vllmPet) {
    if (!bridge) throw new Error('IpcStatusProvider 需要 window.vllmPet')
    this.bridge = bridge
  }

  static available() {
    return typeof window !== 'undefined' && !!window.vllmPet
  }

  start(onStatus) {
    this._unsub = this.bridge.onStatus(onStatus)
  }

  stop() {
    this._unsub?.()
  }

  getConfig() {
    return this.bridge.getConfig()
  }

  saveConfig(patch) {
    return this.bridge.saveConfig(patch)
  }
}

/* ---------------- 浏览器 Mock ---------------- */
export class MockStatusProvider {
  constructor() {
    this._subs = new Set()
    this._snapshot = {
      state: 'idle', intensity: 0, running: 0, waiting: 0,
      cacheUsage: null, tokensPerSec: null, latencyMs: null, models: ['mock-model'], error: null, updatedAt: Date.now()
    }
    let saved = {}
    try {
      saved = JSON.parse(localStorage.getItem('vllm-pet-preview-config') || '{}')
    } catch { /* ignore */ }
    this._config = deepMerge(DEFAULT_CONFIG, saved)
  }

  start(onStatus) {
    this._subs.add(onStatus)
    queueMicrotask(() => onStatus(this._snapshot))
  }

  stop() {
    this._subs.clear()
  }

  /** 预览页手动推送一个（部分）状态快照 */
  push(patch) {
    this._snapshot = { ...this._snapshot, ...patch, updatedAt: Date.now() }
    for (const cb of this._subs) cb(this._snapshot)
  }

  getSnapshot() {
    return this._snapshot
  }

  async getConfig() {
    return structuredClone(this._config)
  }

  async saveConfig(patch) {
    this._config = deepMerge(this._config, patch)
    try {
      localStorage.setItem('vllm-pet-preview-config', JSON.stringify(this._config))
    } catch { /* ignore */ }
    return structuredClone(this._config)
  }
}

/* ---------------- 浏览器真实直连（受 CORS 限制） ---------------- */
export class LiveFetchProvider {
  /**
   * @param {{ apiBase: string, apiKey?: string, pollIntervalMs?: number,
   *           healthPath?: string, metricsPath?: string, thresholds?: object }} opts
   */
  constructor(opts) {
    this.opts = { ...DEFAULT_CONFIG, ...opts }
    this._timer = 0
    this._stopped = true
    this._everConnected = false
    this._lastGenSample = null
    this._lastActivity = null
    this._readyUnsupported = false
    this._modelsUnsupported = false
  }

  start(onStatus) {
    this._onStatus = onStatus
    this._stopped = false
    const tick = async () => {
      if (this._stopped) return
      const snap = await this._pollOnce()
      this._onStatus?.(snap)
      this._timer = setTimeout(tick, Math.max(500, this.opts.pollIntervalMs))
    }
    tick()
  }

  stop() {
    this._stopped = true
    clearTimeout(this._timer)
  }

  /**
   * 判活：默认 healthPath 时依次尝试 `/ready` → `/v1/models`（都是非生成式）。
   * 404/405 = 没有该端点（记住）；401/403 = 要鉴权（试下一个）；其余以响应为准。
   * @returns {Promise<{ ok: boolean, models: string[] }>}
   */
  async _checkHealth(base, headers) {
    if (this.opts.healthPath !== '/health') return { ok: false, models: [] } // 自定义路径 → 交给调用方
    for (const [path, flag] of [['/ready', '_readyUnsupported'], ['/v1/models', '_modelsUnsupported']]) {
      if (this[flag]) continue
      const res = await fetchWithTimeout(base + path, { headers }, 4000)
      if (res.status === 404 || res.status === 405) {
        this[flag] = true
        continue
      }
      if (res.status === 401 || res.status === 403) continue
      if (path === '/v1/models' && res.ok) {
        const data = await res.json().catch(() => null)
        return { ok: true, models: Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [] }
      }
      return { ok: res.ok, models: [] }
    }
    return { ok: false, models: [] }
  }

  async _pollOnce() {
    const base = this.opts.apiBase.replace(/\/+$/, '')
    const headers = this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}
    const startedAt = Date.now()

    // 判活：非生成式优先（/ready → /v1/models → healthPath），与主进程 poller 同策略。
    // ⚠️ SGLang 的 /health 默认会真生成 1 个 token，且那个请求会被 /v1/loads 数成"正在运行"
    //    → 空闲时显示"推理中 ×1 · 0.5 tok/s"，所以绝不能拿它打头（见 DEVELOPMENT §4.11）
    let healthOk = false
    let models = []
    let error = null
    try {
      const health = await this._checkHealth(base, headers)
      healthOk = health.ok
      models = health.models
    } catch (e) {
      error = friendlyFetchError(e)
    }
    if (!healthOk) {
      // 老服务没有 /ready 也没有 /v1/models 时，最后才用可能触发生成的 healthPath
      try {
        const res = await fetchWithTimeout(base + this.opts.healthPath, { headers }, 4000)
        healthOk = res.ok
        if (healthOk) error = null
      } catch (e) {
        error = error || friendlyFetchError(e)
      }
    }

    let metrics = null
    if (healthOk) {
      try {
        const res = await fetchWithTimeout(base + this.opts.metricsPath, { headers }, 4000)
        if (res.ok) metrics = parsePrometheusMetrics(await res.text())
      } catch { /* 老版本可能没有 /metrics，降级为仅存活检测 */ }
    }

    // 三、SGLang 实时负载接口（/metrics gauge 会滞后，计数以它为准）
    let live = null
    if (healthOk && this.opts.backend !== 'vllm' && metrics?.backend !== 'vllm') {
      try {
        const res = await fetchWithTimeout(base + '/v1/loads?include=core', { headers }, 4000)
        if (res.ok) live = parseLoadsResponse(await res.json().catch(() => null))
      } catch { /* 不是 SGLang 或版本过老：保持只用 /metrics */ }
    }

    const load = mergeLoads(live, metrics)
    const loadSource = live ? 'loads' : metrics?.hasConcurrency ? 'metrics' : 'none'

    const wasConnected = this._everConnected
    if (healthOk) this._everConnected = true

    // 活动采样：SGLang 的并发 gauge 看不到正在 prefill 的请求（见 status-core 注释）
    const activity = sampleActivity(load, this._lastActivity)
    this._lastActivity = activity.sample

    const { state, intensity } = deriveState({ healthOk, metrics: load, active: activity.active }, this.opts.thresholds)

    // 生成吞吐：优先 SGLang 每次迭代累加的 counter，其次累计 counter 求差，最后用服务自报吞吐
    const { tokensPerSec, sample } = sampleGenerationRate(load, this._lastGenSample)
    this._lastGenSample = sample

    return {
      state: healthOk ? state : wasConnected ? 'offline' : 'connecting',
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
      hint: healthOk && loadSource === 'none' ? '未读到负载指标' : null,
      error: healthOk ? null : error || '无法连接（浏览器直连受 CORS 限制）',
      updatedAt: Date.now()
    }
  }
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function friendlyFetchError(e) {
  if (e?.name === 'AbortError') return '连接超时'
  return '网络不可达或被 CORS 拦截'
}
