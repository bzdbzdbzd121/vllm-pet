/**
 * pet.js — PetView：把机器人 SVG 挂载到 DOM，按视觉状态切换动画，管理粒子特效。
 *
 * 视觉状态（visual state）：
 *   'idle' | 'sleeping' | 'connecting' | 'busy-1' | 'busy-2' | 'busy-3' | 'offline'
 */
import { applySkinToStage, bobDurationFor } from '../skins/skin-loader.js'

const VISUAL_STATES = ['idle', 'sleeping', 'connecting', 'busy-1', 'busy-2', 'busy-3', 'offline']
const CELEBRATE_MS = 950

export class PetView {
  /**
   * @param {HTMLElement} container 挂载点
   * @param {{ skin: object, scale?: number }} opts
   */
  constructor(container, { skin, scale = 1 } = {}) {
    if (!skin) throw new Error('PetView 需要 skin')
    this.skin = skin
    this.state = 'idle'
    this._celebrateTimer = 0

    this.stage = document.createElement('div')
    this.stage.className = 'pet-stage st-idle'

    this.scaleWrap = document.createElement('div')
    this.scaleWrap.className = 'pet-scale'
    this.scaleWrap.innerHTML = skin.robotSvg

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'pet-status'

    this.stage.append(this.scaleWrap, this.statusEl)
    container.append(this.stage)

    applySkinToStage(this.stage, skin)
    this.setScale(scale)
    this._applyBobDuration()
  }

  /** @param {'idle'|'sleeping'|'connecting'|'busy-1'|'busy-2'|'busy-3'|'offline'} visualState */
  setState(visualState) {
    if (!VISUAL_STATES.includes(visualState) || visualState === this.state) return
    this.stage.classList.remove(`st-${this.state}`)
    this.state = visualState
    this.stage.classList.add(`st-${visualState}`)
    this._applyBobDuration()
  }

  getState() {
    return this.state
  }

  /** 一次性"完成"庆祝动画（弹跳 + 开心眼 + 闪光），随后自动回到原状态 */
  celebrate() {
    clearTimeout(this._celebrateTimer)
    this.stage.classList.remove('is-celebrating')
    // 强制 reflow，保证连续触发时动画能重新播放
    void this.stage.offsetWidth
    this.stage.classList.add('is-celebrating')
    this._burstSparkles()
    this._celebrateTimer = setTimeout(() => {
      this.stage.classList.remove('is-celebrating')
    }, CELEBRATE_MS)
  }

  /** 底部状态文本；传空字符串隐藏 */
  setStatusLine(text) {
    this.statusEl.textContent = text || ''
    this.stage.classList.toggle('show-status', Boolean(text))
  }

  /** 整体缩放：以顶部为原点向下放大（状态文本在舞台下方，窗口底部有留白） */
  setScale(scale) {
    const s = Number(scale) > 0 ? Number(scale) : 1
    this._scale = s
    this.stage.style.transform = `scale(${s})`
    this.stage.style.transformOrigin = '50% 0'
    // 状态文本反向缩放：字号不随体型缩放而变小；宽度定为窗口宽（布局宽度×1/s 后 = 窗口宽-10px）
    this.statusEl.style.transform = `translate(-50%, -100%) scale(${1 / s})`
    const vw = this.stage.ownerDocument?.defaultView?.innerWidth || 240 * s
    this.statusEl.style.width = `${Math.max(120, (vw - 10) * s)}px`
  }

  /** 状态文本字号（px，与体型缩放解耦） */
  setStatusFontSize(px) {
    const v = Number(px)
    this.statusEl.style.fontSize = `${Math.min(24, Math.max(9, v || 11))}px`
  }

  /** 运行时换肤 */
  applySkin(skin) {
    this.skin = skin
    applySkinToStage(this.stage, skin)
    if (skin.robotSvg) this.scaleWrap.innerHTML = skin.robotSvg
    this._applyBobDuration()
  }

  _applyBobDuration() {
    const ms = bobDurationFor(this.skin, this.state)
    this.stage.style.setProperty('--bob-dur', `${ms}ms`)
  }

  _burstSparkles() {
    const layer = this.scaleWrap.querySelector('.r-sparkles')
    if (!layer) return
    const spots = [
      [52, 60], [178, 54], [36, 130], [196, 128], [112, 26], [160, 220]
    ]
    for (const [x, y] of spots) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      el.setAttribute('class', 'fx-sparkle')
      el.setAttribute('x', String(x))
      el.setAttribute('y', String(y))
      el.style.animationDelay = `${Math.random() * 0.25}s`
      el.textContent = '✦'
      layer.append(el)
      setTimeout(() => el.remove(), 1200)
    }
  }
}
