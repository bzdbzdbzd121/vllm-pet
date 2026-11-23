/**
 * pet.js — PetView：把机器人 SVG 挂载到 DOM，按视觉状态切换动画，管理粒子特效。
 *
 * 视觉状态（visual state）：
 *   'idle' | 'sleeping' | 'connecting' | 'busy-1' | 'busy-2' | 'busy-3' | 'offline'
 */
import { applySkinToStage, bobDurationFor } from '../skins/skin-loader.js'
import { normalizeHoverFade } from '../../shared/hover-fade.js'
import { computeHoverRect, containsPoint } from '../../shared/hover-region.js'

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
    this.container = container
    this.state = 'idle'
    this._celebrateTimer = 0
    this._scale = 1
    this._hovering = false
    this._hoverBound = false
    this._hoverRect = null
    this._hoverRectDirty = true

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

    // 状态气泡外面再加一层：外层只管「悬停淡化」，内层保留 0/1 显隐与 0.25s 过渡，
    // 两个 opacity 相乘、互不干扰（直接把淡化写到气泡上会把隐藏的文字重新拉出来）。
    this.statusWrap = document.createElement('div')
    this.statusWrap.className = 'pet-status-wrap'
    this.statusWrap.append(this.statusEl)

    this.stage.append(this.shadowWrap, this.scaleWrap, this.statusWrap)
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
    this.markHoverRectDirty()
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
    this.markHoverRectDirty()
    this._celebrateTimer = setTimeout(() => {
      this.stage.classList.remove('is-celebrating')
      this.markHoverRectDirty()
    }, CELEBRATE_MS)
  }

  /** 底部状态文本；传空字符串隐藏 */
  setStatusLine(text) {
    this.statusEl.textContent = text || ''
    this.stage.classList.toggle('show-status', Boolean(text))
    this._fitStatusWidth()
    this.markHoverRectDirty()
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
    this.markHoverRectDirty()
  }

  /** 状态文本字号（px，与体型缩放解耦） */
  setStatusFontSize(px) {
    const v = Number(px)
    this._statusFontSize = Math.min(24, Math.max(9, v || 11))
    this.statusEl.style.fontSize = `${this._statusFontSize}px`
    this._fitStatusWidth()
    this.markHoverRectDirty()
  }

  /**
   * 气泡宽度贴合文本：用隐藏 span 按真实排版实测字宽（视觉 px）。
   * 注意：气泡在 scale(s) 的舞台内、自身反向 scale(1/s)，净变换 = 1，
   * 因此样式宽度直接等于视觉宽度（content-box，border = 宽 + 20px padding）。
   * 上限按**容器**宽度算（桌面是窗口，预览页是卡片）：缩放 < 1 时舞台会被压窄，
   * 用舞台宽会提前掉行；也避免预览页用整页宽算出过大气泡。
   */
  _fitStatusWidth() {
    const doc = this.stage.ownerDocument
    // 用布局宽度（clientWidth）而非 getBoundingClientRect().width：后者含祖先 CSS transform
    //（预览页 #pet-holder 是 scale(1.15)），拿它跟未缩放的字宽比较会让气泡按 1.15 倍溢出卡片。
    const cw = this._containerSize().w || 240
    const maxBorder = Math.max(120, cw - 10)
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
    // 命中区是矩形：换肤只影响几何 → 标脏重算，状态保留（不再清锁存、不再检查 .r-hover）
    this.markHoverRectDirty()
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
  }

  /**
   * 绑定悬停判定所需的事件。监听挂在**容器**上（桌面 #app、预览 #pet-holder）：
   * 命中区是矩形，容器是天然的事件边界；这样状态文字溢出舞台时也能收到事件。
   *
   * - `pointermove`：主路径（矩形判定）
   * - `pointerover`：**只吃一次**：加载/窗口重新获得焦点时指针可能已经停在本体上，
   *   此时不会有 pointermove。为什么要限量：Chromium 在「指针没动、元素随动画变化」时
   *   也会派发 pointerover，每次都采信就等于把抖动引回来（实测 idle 3–5 次/3.3s）。
   * - 离开/取消：pointerleave、pointercancel（触摸被打断）→ 复位。
   * - 窗口级：blur、页面隐藏 → 复位并重新武装一次 pointerover。
   */
  _bindHoverFade() {
    if (this._hoverBound) return
    this._hoverBound = true
    this._hoverOverArmed = true
    const settle = (e) => this.evaluateHover(e)
    this.container.addEventListener('pointermove', settle, { passive: true })
    this.container.addEventListener('pointerover', (e) => {
      if (!this._hoverOverArmed) return
      this._hoverOverArmed = false
      settle(e)
    })
    // 指针离开容器（含快速移出窗口）、触摸被系统打断（pointercancel）→ 复位
    this.container.addEventListener('pointerleave', () => this.clearHoverFade())
    this.container.addEventListener('pointercancel', () => this.clearHoverFade())
    // 失焦 / 页面隐藏（最小化、切桌面、锁屏）→ 复位，并允许下个 pointerover 重新建立
    window.addEventListener('blur', () => {
      this.clearHoverFade()
      this._hoverOverArmed = true
    })
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return
      this.clearHoverFade()
      this._hoverOverArmed = true
    })
    this._watchContainerResize()
    this._watchContainerScroll()
  }

  /**
   * 滚动也会让命中矩形作废：矩形存的是**客户端坐标**，页面/容器一滚，宠物在屏幕上的位置全变，
   * 但尺寸没变 → ResizeObserver 不会回调。预览页（卡片在可滚动的页面里）必需；桌面版窗口
   * 是 overflow:hidden，这条路径不会触发。
   * scroll 不冒泡，所以用 window 上的捕获监听（能盖住页面滚动与内部滚动容器）。
   * 与 resize 一致：只重算矩形，不重排气泡、不翻转 `.is-hovering`。
   */
  _watchContainerScroll() {
    if (this._scrollWatch) return
    this._scrollWatch = (e) => {
      // 滚动目标与本宠物无关时不必重算（减少无关滚动带来的布局读取）
      const t = e?.target
      if (t && t !== document && t !== window && !(t.contains?.(this.container))) return
      if (!this._hoverRect) return // 还没算过矩形（无人悬停过）→ 下次判定自然是新的
      this.markHoverRectDirty()
      this.getHoverRect()
    }
    window.addEventListener('scroll', this._scrollWatch, { capture: true, passive: true })
  }

  /** 容器尺寸：优先布局尺寸（clientWidth/Height，不含祖先 transform），拿不到时退回渲染尺寸 */
  _containerSize() {
    const el = this.container
    if (!el) return { w: 0, h: 0 }
    const layoutW = Number(el.clientWidth) || 0
    if (layoutW > 0) return { w: layoutW, h: Number(el.clientHeight) || 0 }
    const r = el.getBoundingClientRect?.()
    return { w: r?.width || 0, h: r?.height || 0 }
  }

  /**
   * 容器几何失效路径。
   * 为什么必须有：命中矩形是懒计算 + 脏标记，只在「几何代码主动改」时置脏；
   * 而窗口/预览卡片 resize、页面滚动都是外部布局变化，不改任何几何字段，脏标记一直是干净的 →
   * 矩形停在旧位置，命中区与实际内容错位。
   * 只重算矩形（并让气泡按新宽度重排），**不碰 is-hovering**：
   * 「悬停状态只随指针输入变化」是不抖动的根基（resize 时指针没动，状态就不该翻）。
   */
  _watchContainerResize() {
    if (this._resizeWatch !== undefined) return
    const apply = () => this._invalidateHoverGeometry()
    // 用 ResizeObserver：容器尺寸可能因布局变化（预览页卡片自适应、父元素变化）而变，
    // 这种变化不伴随 window.resize。没有 RO 的环境退回 window.resize。
    const RO = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null
    if (RO) {
      this._resizeWatch = new RO(apply)
      this._resizeWatch.observe(this.container)
    } else {
      this._resizeWatch = null
      window.addEventListener('resize', apply, { passive: true })
    }
    const { w, h } = this._containerSize()
    this._geomW = w
    this._geomH = h
  }

  /** 几何失效：同尺寸回调（RO 首次回调）不做事；尺寸真变了才重排气泡 + 重算矩形 */
  _invalidateHoverGeometry() {
    const { w, h } = this._containerSize()
    if (w === this._geomW && h === this._geomH) return
    this._geomW = w
    this._geomH = h
    this._fitStatusWidth()
    this.markHoverRectDirty()
    // 立即重算（下一条指针事件直接用新矩形）；重算本身不判定悬停，状态保持原样
    this.getHoverRect()
  }

  /** 标脏：下一次判定前重算命中矩形（只在几何可能变化时调用，不逐帧重算） */
  markHoverRectDirty() {
    this._hoverRectDirty = true
  }

  /**
   * 算命中矩形（懒计算 + 脏标记）：union(本体, 阴影, 当前可见文字) → 外扩 12×缩放 → 裁剪到容器。
   * `.r-hover` 只是「本体」的首选来源；缺失时退回 `.pet-scale`，再退回容器（不告警、不失效）。
   */
  getHoverRect() {
    if (this._hoverRect && !this._hoverRectDirty) return this._hoverRect
    const rectOf = (el) => {
      const r = el?.getBoundingClientRect?.()
      return r && (r.width > 0 || r.height > 0) ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
    }
    const art = rectOf(this.stage.querySelector('.r-hover')) || rectOf(this.scaleWrap) || null
    // 阴影必须取绘制图形（.pet-shadow 是 inset:0 的满舞台层，取它会撑满整窗）
    const shadow = rectOf(this.stage.querySelector('.pet-shadow .r-shadow'))
    const statusShown = this.stage.classList.contains('show-status') && Boolean(this.statusEl.textContent)
    const status = statusShown ? rectOf(this.statusEl) : null
    this._hoverRect = computeHoverRect({ art, shadow, status }, rectOf(this.container), this._scale)
    this._hoverRectDirty = false
    return this._hoverRect
  }

  /** 单次悬停判定：在矩形内，且不落在内嵌设置面板上 */
  evaluateHover(e) {
    const rect = this.getHoverRect()
    const onPanel = Boolean(e?.target?.closest?.('.pet-settings'))
    this._setHovering(!onPanel && containsPoint(rect, e?.clientX, e?.clientY))
  }

  /** 锁存悬停状态：只在指针事件里调用；状态未变时不重复写 DOM */
  _setHovering(over) {
    const next = !!over
    if (next === this._hovering) return
    this._hovering = next
    this.stage.classList.toggle('is-hovering', next)
  }

  /** 清除悬停锁存（失焦/锁屏/页面隐藏/关闭开关时调用） */
  clearHoverFade() {
    this._setHovering(false)
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
