/**
 * config-store.js — 配置持久化（<userData>/config.json）
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_CONFIG = Object.freeze({
  apiBase: '',
  apiKey: '',
  pollIntervalMs: 2000,
  metricsPath: '/metrics',
  healthPath: '/health',
  thresholds: { light: 1, medium: 4, heavy: 16, cacheHeavy: 0.85 },
  stateMap: { light: 'busy-1', medium: 'busy-2', heavy: 'busy-3' },
  showStatus: true,
  skin: 'default-robot',
  idleSleepMinutes: 10,
  window: { alwaysOnTop: true, clickThrough: false, scale: 1, opacity: 1, x: null, y: null }
})

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

export class ConfigStore {
  /** @param {string} userDataDir Electron app.getPath('userData') */
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json')
    this._config = null
  }

  load() {
    if (this._config) return structuredClone(this._config)
    let saved = {}
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch { /* 首次运行或文件损坏都用默认 */ }
    this._config = deepMerge(DEFAULT_CONFIG, saved)
    return structuredClone(this._config)
  }

  /** 深合并 patch 并落盘，返回合并后的完整配置 */
  save(patch) {
    const next = deepMerge(this.load(), patch)
    this._config = next
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(next, null, 2))
    } catch (err) {
      console.error('[vllm-pet] 配置写入失败', err)
    }
    return structuredClone(next)
  }
}
