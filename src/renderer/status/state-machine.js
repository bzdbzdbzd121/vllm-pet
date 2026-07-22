/**
 * state-machine.js — 把 StatusSnapshot 流映射为桌宠视觉状态。
 *
 * StatusSnapshot: { state, intensity, running, waiting, cacheUsage, latencyMs, models, error, updatedAt }
 * 视觉状态: 'idle' | 'sleeping' | 'connecting' | 'busy-1..3' | 'offline'
 */
const SLEEP_CHECK_MS = 2000
const BUSY_ANIMATIONS = ['busy-1', 'busy-2', 'busy-3']
export const DEFAULT_STATE_MAP = Object.freeze({ light: 'busy-1', medium: 'busy-2', heavy: 'busy-3' })

export class PetStateMachine {
  /**
   * @param {{
   *   onVisualState: (visual: string, snap: object) => void,
   *   onStatusLine?: (text: string) => void,
   *   onCelebrate?: () => void,
   *   idleSleepMinutes?: number,
   *   stateMap?: { light?: string, medium?: string, heavy?: string }
   * }} opts
   */
  constructor({ onVisualState, onStatusLine, onCelebrate, idleSleepMinutes = 10, stateMap }) {
    this.onVisualState = onVisualState
    this.onStatusLine = onStatusLine || (() => {})
    this.onCelebrate = onCelebrate || (() => {})
    this.idleSleepMs = Math.max(1, idleSleepMinutes) * 60_000
    this.stateMap = { ...DEFAULT_STATE_MAP }
    this.setStateMap(stateMap)
    this.visual = 'connecting'
    this.idleSince = null
    this._timer = setInterval(() => this._checkSleep(), SLEEP_CHECK_MS)
  }

  setIdleSleepMinutes(min) {
    this.idleSleepMs = Math.max(1, Number(min) || 10) * 60_000
  }

  /** 更新 负载档位 → 动画 映射（非法值回退默认） */
  setStateMap(map) {
    for (const key of ['light', 'medium', 'heavy']) {
      if (map?.[key] && BUSY_ANIMATIONS.includes(map[key])) {
        this.stateMap[key] = map[key]
      }
    }
  }

  /** @param {object} snap StatusSnapshot */
  update(snap) {
    if (!snap || typeof snap !== 'object') return
    const prev = this.visual
    let next

    if (snap.state === 'offline') next = 'offline'
    else if (snap.state === 'connecting') next = 'connecting'
    else if (snap.state === 'busy') {
      const intensity = Math.min(3, Math.max(1, snap.intensity || 1))
      const key = intensity === 3 ? 'heavy' : intensity === 2 ? 'medium' : 'light'
      next = this.stateMap[key] || `busy-${intensity}`
    } else next = 'idle'

    // 连续空闲计时：离开 idle 就清零
    if (next === 'idle' && prev !== 'idle' && prev !== 'sleeping') {
      this.idleSince = Date.now()
      if (prev.startsWith('busy')) this.onCelebrate()
    } else if (next !== 'idle' && next !== 'sleeping') {
      this.idleSince = null
    }

    // 忙碌或恢复活动时醒来
    if (this.visual === 'sleeping' && next !== 'idle') {
      // fall through：next 会覆盖 sleeping
    } else if (this.visual === 'sleeping' && next === 'idle') {
      next = 'sleeping'
    }

    if (next !== this.visual) {
      this.visual = next
      this.onVisualState(next, snap)
    }
    this.onStatusLine(formatStatusLine(snap))
  }

  _checkSleep() {
    if (this.visual === 'idle' && this.idleSince && Date.now() - this.idleSince >= this.idleSleepMs) {
      this.visual = 'sleeping'
      this.onVisualState('sleeping', null)
    }
  }

  dispose() {
    clearInterval(this._timer)
  }
}

/** 状态气泡文本，例如 "推理中 ×6 · 队列 2 · 86 tok/s · KV 73%" */
export function formatStatusLine(snap) {
  if (!snap) return ''
  switch (snap.state) {
    case 'offline':
      return snap.error ? `离线：${snap.error}` : '离线：服务不可达'
    case 'connecting':
      return snap.error || '连接中…'
    case 'busy': {
      // 段内用不换行空格：换行只发生在 · 分隔处，避免 "KV / 91%" 这种难看断行
      const parts = [`推理中 ×${snap.running ?? 0}`]
      if (snap.waiting) parts.push(`队列 ${snap.waiting}`)
      if (snap.tokensPerSec > 0) parts.push(`${formatTps(snap.tokensPerSec)} tok/s`) // 0 / null 不显示
      if (snap.cacheUsage != null) parts.push(`KV ${Math.round(snap.cacheUsage * 100)}%`)
      return parts.join(' · ')
    }
    case 'idle':
      return '空闲中'
    default:
      return ''
  }
}

/** tok/s 数值格式化：>= 10 取整，否则保留 1 位小数 */
function formatTps(v) {
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1)
}
