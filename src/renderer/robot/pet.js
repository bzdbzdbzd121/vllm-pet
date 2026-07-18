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

    this.fx = document.createElement('div')
    this.fx.className = 'pet-fx'
    this.fx.innerHTML = [
      '<span class="fx-steam s1"></span><span class="fx-steam s2"></span>',
      '<span class="fx-steam s3"></span><span class="fx-steam s4"></span>',
      '<span class="fx-sweat w1"></span><span class="fx-sweat w2"></span>',
      '<i class="fx-speed l1"></i><i class="fx-speed l2"></i><i class="fx-speed l3"></i>',
      '<span class="fx-zzz z1">Z</span><span class="fx-zzz z2">Z</span><span class="fx-zzz z3">Z</span>',
      '<span class="fx-alert">!</span>'
    ].join('')

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'pet-status'

    this.stage.append(this.scaleWrap, this.fx, this.statusEl)
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

  /** 顶部状态文本；传空字符串隐藏 */
  setStatusLine(text) {
    this.statusEl.textContent = text || ''
    this.stage.classList.toggle('show-status', Boolean(text))
  }

  /** 整体缩放：缩放整个舞台（机器人+特效+状态文本一起），状态文本始终在头顶上方 */
  setScale(scale) {
    const s = Number(scale) > 0 ? Number(scale) : 1
    this.stage.style.transform = `scale(${s})`
    this.stage.style.transformOrigin = '50% 100%'
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
    const spots = [
      [52, 60], [178, 54], [36, 130], [196, 128], [112, 26], [160, 220]
    ]
    for (const [x, y] of spots) {
      const el = document.createElement('span')
      el.className = 'fx-sparkle'
      el.textContent = '✦'
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.animationDelay = `${Math.random() * 0.25}s`
      this.fx.append(el)
      setTimeout(() => el.remove(), 1200)
    }
  }
}
