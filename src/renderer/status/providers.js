/**
 * providers.js — 状态来源抽象。
 *   IpcStatusProvider  — Electron 桌面窗口（主进程轮询，经 preload 桥 window.vllmPet）
 *   MockStatusProvider — 浏览器预览：手动推送状态 + localStorage 模拟配置
 *   LiveFetchProvider  — 浏览器"真实直连"：直接 fetch vLLM（受 CORS 限制，仅调试用）
 */
import { parsePrometheusMetrics, deriveState, tokenRate, DEFAULT_THRESHOLDS } from '../../shared/status-core.js'

export const DEFAULT_CONFIG = Object.freeze({
  apiBase: '',
  apiKey: '',
  pollIntervalMs: 2000,
  metricsPath: '/metrics',
  healthPath: '/health',
  thresholds: { ...DEFAULT_THRESHOLDS },
  stateMap: { light: 'busy-1', medium: 'busy-2', heavy: 'busy-3' },
  showStatus: true,
  skin: 'default-robot',
  idleSleepMinutes: 10,
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
    this._lastGenTokens = null
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

  async _pollOnce() {
    const base = this.opts.apiBase.replace(/\/+$/, '')
    const headers = this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}
    const startedAt = Date.now()

    let healthOk = false
    let models = []
    let error = null
    try {
      const res = await fetchWithTimeout(base + this.opts.healthPath, { headers }, 4000)
      healthOk = res.ok
    } catch (e) {
      error = friendlyFetchError(e)
    }
    if (!healthOk) {
      try {
        const res = await fetchWithTimeout(base + '/v1/models', { headers }, 4000)
        healthOk = res.ok
        if (res.ok) {
          const data = await res.json().catch(() => null)
          models = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : []
          error = null
        }
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

    const wasConnected = this._everConnected
    if (healthOk) this._everConnected = true
    const { state, intensity } = deriveState({ healthOk, metrics }, this.opts.thresholds)

    let tokensPerSec = null
    if (metrics?.genTokensTotal != null) {
      const curr = { value: metrics.genTokensTotal, at: Date.now() }
      tokensPerSec = tokenRate(this._lastGenTokens, curr)
      this._lastGenTokens = curr
    }

    return {
      state: healthOk ? state : wasConnected ? 'offline' : 'connecting',
      intensity,
      running: metrics?.running ?? 0,
      waiting: metrics?.waiting ?? 0,
      cacheUsage: metrics?.cacheUsage ?? null,
      tokensPerSec,
      latencyMs: Date.now() - startedAt,
      models,
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
