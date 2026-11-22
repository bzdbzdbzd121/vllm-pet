/**
 * pet.js — PetView：把机器人 SVG 挂载到 DOM，按视觉状态切换动画，管理粒子特效。
 *
 * 视觉状态（visual state）：
 *   'idle' | 'sleeping' | 'connecting' | 'busy-1' | 'busy-2' | 'busy-3' | 'offline'
 */
import { applySkinToStage, bobDurationFor } from '../skins/skin-loader.js'
import { normalizeHoverFade } from '../../shared/hover-fade.js'

const VISUAL_STATES = ['idle', 'sleeping', 'connecting', 'busy-1', 'busy-2', 'busy-3', 'offline']
const CELEBRATE_MS = 950

/**
 * 把地面阴影（.r-shadow）从皮肤 SVG 中剥离成独立 SVG：
 * 整体浮动动画在 HTML 包装层（GPU 合成）上进行，阴影必须留在地面不能跟着飘。
 * 皮肤没有 .r-shadow 或解析失败时原样返回（阴影随身体浮动，属可接受降级）。
 */
function splitShadow(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    const svg = doc.documentElement
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return { body: svgText, shadow: '' }
    const shadowEl = svg.querySelector('.r-shadow')
    if (!shadowEl) return { body: svgText, shadow: '' }
    const shadowSvg = svg.cloneNode(false) // 浅拷贝根节点，保留 class/viewBox
    shadowEl.remove()
    shadowSvg.append(shadowEl)
    const ser = new XMLSerializer()
    return { body: ser.serializeToString(svg), shadow: ser.serializeToString(shadowSvg) }
  } catch {
    return { body: svgText, shadow: '' }
  }
}

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
    this._hoverWarned = false
    this._hovering = false
    this._hoverBound = false

    this.stage = document.createElement('div')
    this.stage.className = 'pet-stage st-idle'

    // 地面阴影剥离到独立层：bob 动画在 HTML 层走合成器，阴影不随机器人浮动
    const { body, shadow } = splitShadow(skin.robotSvg)
    this.shadowWrap = document.createElement('div')
    this.shadowWrap.className = 'pet-shadow'
    this.shadowWrap.innerHTML = shadow

    this.scaleWrap = document.createElement('div')
    this.scaleWrap.className = 'pet-scale'
    this.scaleWrap.innerHTML = body

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'pet-status'

    this.stage.append(this.shadowWrap, this.scaleWrap, this.statusEl)
    container.append(this.stage)

    applySkinToStage(this.stage, skin)
    this.setScale(scale)
    this._applyBobDuration()
    this._bindHoverFade()
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
    this._fitStatusWidth()
  }

  /** 整体缩放：以顶部为原点向下放大（状态文本在舞台下方，窗口底部有留白） */
  setScale(scale) {
    const s = Number(scale) > 0 ? Number(scale) : 1
    this._scale = s
    this.stage.style.transform = `scale(${s})`
    this.stage.style.transformOrigin = '50% 0'
    // 状态文本反向缩放：字号不随体型缩放而变小
    this.statusEl.style.transform = `translate(-50%, -100%) scale(${1 / s})`
    this._fitStatusWidth()
  }

  /** 状态文本字号（px，与体型缩放解耦） */
  setStatusFontSize(px) {
    const v = Number(px)
    this._statusFontSize = Math.min(24, Math.max(9, v || 11))
    this.statusEl.style.fontSize = `${this._statusFontSize}px`
    this._fitStatusWidth()
  }

  /**
   * 气泡宽度贴合文本：用隐藏 span 按真实排版实测字宽（视觉 px）。
   * 注意：气泡在 scale(s) 的舞台内、自身反向 scale(1/s)，净变换 = 1，
   * 因此样式宽度直接等于视觉宽度（content-box，border = 宽 + 20px padding）。
   * 超上限（窗口宽-10px）时定宽，由 CSS 换行（最多两行）。
   */
  _fitStatusWidth() {
    const doc = this.stage.ownerDocument
    const vw = doc?.defaultView?.innerWidth || 240
    const maxBorder = Math.max(120, vw - 10)
    const text = this.statusEl.textContent
    let content = 16
    if (text && doc) {
      const span = (this._measureSpan ||= (() => {
        const el = doc.createElement('span')
        el.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;'
        ;(doc.body || doc.documentElement).append(el)
        return el
      })())
      span.style.font = `${this._statusFontSize || 11}px "PingFang SC", "Microsoft YaHei", sans-serif`
      span.textContent = text
      content = Math.ceil(span.getBoundingClientRect().width)
    }
    // content-box 宽度 = 文本宽 + 余量；上限扣除 20px padding 使 border 不超窗
    this.statusEl.style.width = `${Math.max(16, Math.min(content + 4, maxBorder - 20))}px`
  }

  /** 运行时换肤 */
  applySkin(skin) {
    this.skin = skin
    applySkinToStage(this.stage, skin)
    if (skin.robotSvg) {
      const { body, shadow } = splitShadow(skin.robotSvg)
      this.scaleWrap.innerHTML = body
      this.shadowWrap.innerHTML = shadow
    }
    this._applyBobDuration()
    // 换肤会整体替换本体 SVG：新皮肤可能没有 .r-hover，需重新检查命中区
    // （开关状态以 stage 上的 class 为单一来源，不另存副本）
    // 锁存也要清：命中区几何变了，旧状态不再成立（缺钩子时应为不淡化）
    this.clearHoverFade()
    if (this.stage.classList.contains('hover-fade-enabled')) this._warnIfNoHitRegion()
  }

  /**
   * 悬停淡化：开关挂 class，不透明度写 CSS 变量，命中状态由指针事件锁存。
   * 为什么不用 CSS `:hover`（曾经的做法）：伪类由渲染引擎跟随命中测试逐帧重算，
   * 而桌子自己一直在 bob/sway/celebrate，静止指针的状态就会跟着几何来回翻，
   * 表现为 opacity 在设定值与 1 之间呼吸式抖动（实测最坏连续失效 2.4–3.9s）。
   * class 只由 enabled 决定：把滑块改成 100% 不需要增删 class，行为可预测。
   * @param {unknown} input config.hoverFade（畸形值由 normalizeHoverFade 收口）
   */
  setHoverFade(input) {
    const { enabled, opacity } = normalizeHoverFade(input)
    this.stage.style.setProperty('--hover-opacity', String(opacity))
    this.stage.classList.toggle('hover-fade-enabled', enabled)
    // 关闭时一并清掉锁存，否则「关→开」会把关闭前的悬停状态带回来
    if (!enabled) this.clearHoverFade()
    if (enabled) this._warnIfNoHitRegion()
  }

  /**
   * 绑定悬停判定所需的事件。只绑 pointermove + pointerleave：
   * pointerover/pointerout 在「指针没动、元素随动画变化」时也可能被派发，会把抖动引回来。
   * 监听挂在 stage 上：换肤只替换本体 SVG，挂在 .r-hover 上会丢。
   */
  _bindHoverFade() {
    if (this._hoverBound) return
    this._hoverBound = true
    this.stage.addEventListener('pointermove', (e) => {
      const target = e?.target
      this._setHovering(!!(target && typeof target.closest === 'function' && target.closest('.r-hover')))
    }, { passive: true })
    // 指针离开舞台（含快速移出窗口）→ 复位
    this.stage.addEventListener('pointerleave', () => this.clearHoverFade())
    // 失焦 / 页面隐藏（最小化、切桌面、锁屏）→ 复位，避免回来时残留淡化
    window.addEventListener('blur', () => this.clearHoverFade())
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearHoverFade()
    })
  }

  /** 锁存悬停状态：只在指针事件里调用；状态未变时不重复写 DOM */
  _setHovering(over) {
    const next = !!over
    if (next === this._hovering) return
    this._hovering = next
    this.stage.classList.toggle('is-hovering', next)
  }

  /** 清除悬停锁存（失焦/锁屏/页面隐藏/关闭开关/换肤时调用） */
  clearHoverFade() {
    this._setHovering(false)
  }

  /** 皮肤缺 .r-hover 时悬停不会生效：只提示一次，不报错 */
  _warnIfNoHitRegion() {
    // 延到下一个微任务再查 DOM：一次配置应用里 setHoverFade 之后紧接的就是 applySkin
    //（整体替换本体 SVG），同步检查看到的是换肤前的旧 DOM，会误报「刚换到好皮肤却说缺分组」。
    queueMicrotask(() => {
      if (this._hoverWarned || this.stage.querySelector('.r-hover')) return
      this._hoverWarned = true
      console.warn('[vllm-pet] 皮肤缺少 .r-hover 分组，悬停变透明不会生效（见 src/renderer/skins/README.md）')
    })
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
