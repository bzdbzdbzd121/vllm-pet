import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { normalizeHoverFade } from '../src/shared/hover-fade.js'
import { computeHoverRect, containsPoint } from '../src/shared/hover-region.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ------------------------------------------------------------------
 * 极简 DOM 替身：足以实例化真实的 PetView 并驱动它的指针事件。
 * 断言的是**真实方法体**的行为（矩形判定/设置面板排除/脏标记/包装层），不是源码字符串。
 * ------------------------------------------------------------------ */
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top })
// 当前假 document：makeEl 造出来的元素靠它回答 ownerDocument（pet.js 用它测量文本宽度）
let activeDoc = null

function makeEl({ rect: r = rect(0, 0, 0, 0), textContent = '' } = {}) {
  const classes = new Set()
  const props = new Map()
  const children = []
  const el = {
    textContent,
    children,
    style: {
      cssText: '',
      setProperty: (k, v) => props.set(k, String(v)),
      getPropertyValue: (k) => props.get(k) || ''
    },
    classList: {
      contains: (c) => classes.has(c),
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c))
    },
    className: '',
    get ownerDocument() { return activeDoc },
    set rect(v) { r = v },
    getBoundingClientRect: () => r,
    append: (...kids) => kids.forEach((k) => children.push(k)),
    appendChild: (k) => children.push(k),
    querySelector: () => null,
    addEventListener: () => {},
    offsetWidth: 1,
    _classes: classes,
    _props: props
  }
  return el
}

function loadPet({ boxes: sharedBoxes = {}, showStatus = true, statusText = '空闲中', warn = () => {} } = {}) {
  // 浅拷贝：用例会平移几何（模拟滚动），不能污染共享的 BOXES
  const boxes = { ...sharedBoxes }
  const handlers = new Map()
  const doc = {
    hidden: false,
    addEventListener: (t, fn) => { handlers.set(`doc:${t}`, [fn]) },
    // 假排版：字宽 7px/字（含 CJK），让「气泡宽度上限」这条路径真正生效
    // （否则文本测到 0 宽，上限永远不生效，用例会空转成「两种实现都算出同一个数」）
    createElement: () => {
      const el = makeEl()
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => rect(0, 0, [...String(el.textContent || '')].length * 7, 16)
      })
      return el
    },
    head: { append: () => {} },
    body: { append: () => {} },
    documentElement: { append: () => {} },
    dispatch: (t) => (handlers.get(`doc:${t}`) || []).forEach((fn) => fn({}))
  }
  activeDoc = doc
  const container = makeEl({ rect: boxes.container || rect(0, 0, 240, 280) })
  container.addEventListener = (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, [])
    handlers.get(type).push(fn)
  }
  container.dispatch = (type, event) => (handlers.get(type) || []).forEach((fn) => fn(event))

  const win = { addEventListener: (t, fn) => { handlers.set(`win:${t}`, [...(handlers.get(`win:${t}`) || []), fn]) } }
  const resizeObservers = []
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.targets = []; resizeObservers.push(this) }
    observe(el) { this.targets.push(el) }
    unobserve(el) { this.targets = this.targets.filter((t) => t !== el) }
    disconnect() { this.targets = [] }
    fire() { this.cb([], this) }
  }
  const sandbox = {
    applySkinToStage: () => {},
    ResizeObserver: FakeResizeObserver,
    bobDurationFor: () => 1000,
    normalizeHoverFade,
    queueMicrotask,
    console: { warn: (...a) => warn(a.join(' ')) },
    document: doc,
    window: win,
    DOMParser: class { parseFromString() { throw new Error('no dom parser in test') } },
    XMLSerializer: class { serializeToString() { return '' } },
    setTimeout, clearTimeout
  }
  const src = read('src/renderer/robot/pet.js')
    .replace(/^import \{[^}]*\} from '\.\.\/skins\/skin-loader\.js'$/m, '')
    .replace(/^import \{[^}]*\} from '\.\.\/\.\.\/shared\/hover-fade\.js'$/m, '')
    .replace(/^import \{[^}]*\} from '\.\.\/\.\.\/shared\/hover-region\.js'$/m, '')
    .replace(/^export /gm, '')
  // hover-region 是纯函数，直接注入沙箱（等价于模块导入）
  sandbox.computeHoverRect = computeHoverRect
  sandbox.containsPoint = containsPoint
  const PetView = vm.runInNewContext(`${src}\n;PetView`, sandbox)

  const pet = new PetView(container, { skin: { robotSvg: '<svg/>' }, scale: boxes.scale || 1 })
  // 用可配置的几何替换构造函数里创建的元素（构造函数只负责结构，几何由测试给）
  pet.scaleWrap.getBoundingClientRect = () => boxes.scaleBox || boxes.container || rect(0, 0, 240, 280)
  const baseQuery = pet.stage.querySelector.bind(pet.stage)
  pet.stage.querySelector = (sel) => {
    if (sel === '.r-hover') return boxes.art ? makeEl({ rect: boxes.art }) : null
    if (sel === '.pet-shadow .r-shadow') return boxes.shadow ? makeEl({ rect: boxes.shadow }) : null
    if (sel === '.pet-status') return pet.statusEl
    return baseQuery(sel)
  }
  pet.statusEl.getBoundingClientRect = () => boxes.status || rect(92, 248, 149, 272)
  if (showStatus) pet.stage.classList.add('show-status')
  pet.setStatusLine(statusText)
  const fireResize = () => resizeObservers.filter((o) => o.targets.includes(container)).forEach((o) => o.fire())
  // 把世界整体上移 dy（等价于页面向下滚动 dy）：所有客户端矩形同步平移，尺寸不变
  const scrollBy = (dy) => {
    const shift = (r) => (r ? rect(r.left, r.top - dy, r.right, r.bottom - dy) : r)
    container.rect = shift(container.getBoundingClientRect())
    for (const k of ['container', 'scaleBox', 'art', 'shadow', 'status']) if (boxes[k]) boxes[k] = shift(boxes[k])
  }
  const fireScroll = (target = doc) => (handlers.get('win:scroll') || []).forEach((fn) => fn({ type: 'scroll', target }))
  return { pet, container, doc, win, boxes, resizeObservers, fireResize, scrollBy, fireScroll }
}

const pointer = (x, y, target = { closest: () => null }) => ({ clientX: x, clientY: y, target })
const onPanel = (x, y) => ({ clientX: x, clientY: y, target: { closest: (sel) => (sel === '.pet-settings' ? {} : null) } })

const BOXES = {
  container: rect(0, 0, 240, 280),
  art: rect(48, 17, 192, 225),
  shadow: rect(76, 223, 164, 241),
  status: rect(92, 248, 149, 272)
}

/* ---------------- 命中判定（矩形语义） ---------------- */

test('命中：矩形内（本体 / 阴影 / 文字 / 矩形里的空隙）都淡化', () => {
  const { pet } = loadPet({ boxes: BOXES })
  for (const [x, y, label] of [[120, 114, '本体内部'], [120, 36, '天线灯球'], [81, 195, '臂身空隙'], [120, 166, '头身缝隙'], [132, 36, '光晕环'], [120, 232, '地面阴影'], [120, 260, '状态文字']]) {
    pet.container.dispatch('pointermove', pointer(x, y))
    assert.ok(pet.stage.classList.contains('is-hovering'), `${label} (${x},${y}) 应命中`)
  }
})

test('命中：矩形外（左右空白 / 四角 / 容器外）不淡化', () => {
  const { pet } = loadPet({ boxes: BOXES })
  for (const [x, y, label] of [[20, 140, '左侧空白'], [225, 140, '右侧空白'], [5, 5, '左上角'], [-10, 140, '容器左侧外'], [120, -10, '容器上方外']]) {
    pet.container.dispatch('pointermove', pointer(x, y))
    assert.ok(!pet.stage.classList.contains('is-hovering'), `${label} (${x},${y}) 不应命中`)
  }
})

test('命中：闭区间边界（矩形左右上下边算命中，外面 0.1px 不算）', () => {
  const { pet } = loadPet({ boxes: BOXES })
  const rectNow = pet.getHoverRect()
  for (const [x, y] of [[rectNow.left, rectNow.top], [rectNow.right, rectNow.bottom]]) {
    pet.container.dispatch('pointermove', pointer(x, y))
    assert.ok(pet.stage.classList.contains('is-hovering'), `边界点 (${x},${y}) 应命中`)
  }
  pet.container.dispatch('pointermove', pointer(rectNow.left - 0.1, 100))
  assert.ok(!pet.stage.classList.contains('is-hovering'))
})

test('矩形算法：本体/阴影外扩 12×缩放 → 并入文字原盒 → 裁剪到容器', () => {
  const { pet } = loadPet({ boxes: BOXES })
  // 本体/阴影并集 (48,17,192,241) 外扩 12 → (36,5,204,253)；文字原盒 (92,248,149,272) 并入
  // → (36,5,204,272)。文字不加外扩，所以底边停在 272 而不是被裁到窗底 280。
  assert.deepEqual(pet.getHoverRect(), { left: 36, top: 5, right: 204, bottom: 272 })
})

test('命中：设置面板上不淡化（即使落在矩形内）', () => {
  const { pet } = loadPet({ boxes: BOXES })
  pet.container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))
  pet.container.dispatch('pointermove', onPanel(120, 114))
  assert.ok(!pet.stage.classList.contains('is-hovering'), '面板上必须不淡化')
})

test('缺 .r-hover：用 .pet-scale 兜底，功能照常（不告警、不失效）', () => {
  const warns = []
  const { pet } = loadPet({ boxes: { ...BOXES, art: null }, warn: (m) => warns.push(m) })
  pet.setHoverFade({ enabled: true })
  pet.container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'), '缺分组也必须命中（用 .pet-scale 的包围盒）')
  return new Promise((r) => setTimeout(r, 0)).then(() => assert.deepEqual(warns, [], '不得再告警 .r-hover 缺失'))
})

/* ---------------- 状态文字显隐 ---------------- */

test('状态文字隐藏：文字行不再命中；本体/阴影仍命中', () => {
  const { pet } = loadPet({ boxes: BOXES, statusText: '' })
  assert.ok(!pet.stage.classList.contains('show-status'))
  pet.container.dispatch('pointermove', pointer(120, 260))
  assert.ok(!pet.stage.classList.contains('is-hovering'), '文字隐藏后原文字位置不应命中')
  pet.container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))
})

test('状态文字出现后命中区随之变大（脏标记生效）', () => {
  const { pet } = loadPet({ boxes: BOXES, statusText: '' })
  const before = pet.getHoverRect()
  pet.setStatusLine('推理中 ×3 · KV cache 87% · 12.3 tok/s')
  pet.statusEl.getBoundingClientRect = () => rect(10, 248, 230, 272)
  const after = pet.getHoverRect()
  assert.ok(after.left < before.left, '文字变宽后命中矩形应变宽')
  pet.container.dispatch('pointermove', pointer(30, 250))
  assert.ok(pet.stage.classList.contains('is-hovering'), '新矩形内的点应命中')
})

/* ---------------- 脏标记：懒计算，不逐帧重算 ---------------- */

test('脏标记：几何变化才重算，正常判定不重算', () => {
  const { pet } = loadPet({ boxes: BOXES })
  pet.getHoverRect()
  let calls = 0
  const orig = pet.stage.querySelector
  pet.stage.querySelector = (sel) => { if (sel === '.r-hover') calls++; return orig(sel) }
  pet.container.dispatch('pointermove', pointer(120, 114))
  pet.container.dispatch('pointermove', pointer(121, 115))
  assert.equal(calls, 0, '状态未变时不应重算矩形')
  pet.setStatusLine('新文字')
  pet.container.dispatch('pointermove', pointer(120, 114))
  assert.ok(calls > 0, '文字变化后必须重算一次')
})

test('脏标记：setScale / setStatusFontSize / setState / celebrate / applySkin 都置脏', () => {
  const { pet } = loadPet({ boxes: BOXES })
  for (const [name, act] of [
    ['setScale', () => pet.setScale(2)],
    ['setStatusFontSize', () => pet.setStatusFontSize(14)],
    ['setState', () => pet.setState('busy-3')],
    ['applySkin', () => pet.applySkin({})]
  ]) {
    pet.getHoverRect()
    assert.equal(pet._hoverRectDirty, false, `${name} 之前应为干净`)
    act()
    assert.equal(pet._hoverRectDirty, true, `${name} 必须置脏`)
  }
  pet.getHoverRect()
  pet.celebrate()
  assert.equal(pet._hoverRectDirty, true, 'celebrate 必须置脏')
})

/* ---------------- 事件绑定 / 复位 ---------------- */

test('绑定：事件挂容器（不是舞台），且不绑 pointerout/mouse*', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  for (const type of ['pointermove', 'pointerover', 'pointerleave', 'pointercancel']) {
    assert.ok((container._handlers?.get?.(type)?.length ?? 0) >= 0)
  }
  const src = read('src/renderer/robot/pet.js')
  assert.match(src, /this\.container\.addEventListener\('pointermove'/)
  assert.match(src, /this\.container\.addEventListener\('pointerover'/)
  assert.match(src, /this\.container\.addEventListener\('pointerleave'/)
  assert.match(src, /this\.container\.addEventListener\('pointercancel'/)
  assert.doesNotMatch(src, /this\.stage\.addEventListener\('pointer/)
  assert.doesNotMatch(src, /addEventListener\(\s*['"](pointerout|mouseover|mouseout|mouseenter|mouseleave)/)
  assert.doesNotMatch(src, /elementFromPoint/, '不得用 elementFromPoint 轮询')
})

test('复位：pointerleave / pointercancel / blur / 页面隐藏 都清状态', () => {
  const { pet, container, doc } = loadPet({ boxes: BOXES })
  for (const trigger of ['pointerleave', 'pointercancel', 'blur', 'visibility']) {
    container.dispatch('pointermove', pointer(120, 114))
    assert.ok(pet.stage.classList.contains('is-hovering'), `${trigger}: 前置应悬停`)
    if (trigger === 'blur') container.dispatch('win:blur', {})
    else if (trigger === 'visibility') { doc.hidden = true; doc.dispatch('visibilitychange') }
    else container.dispatch(trigger, {})
    assert.ok(!pet.stage.classList.contains('is-hovering'), `${trigger} 后必须复位`)
  }
})

test('复位：关闭开关清状态，重新开启不带回旧状态', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  pet.setHoverFade({ enabled: true })
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))
  pet.setHoverFade({ enabled: false })
  assert.ok(!pet.stage.classList.contains('is-hovering'))
  pet.setHoverFade({ enabled: true })
  assert.ok(!pet.stage.classList.contains('is-hovering'), '重开需等下一条指针事件')
})

test('换肤：状态保留（不再清锁存），只重算矩形', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))
  pet.applySkin({})
  assert.ok(pet.stage.classList.contains('is-hovering'), '换肤不应清掉悬停状态')
  assert.equal(pet._hoverRectDirty, true, '换肤后必须重算矩形')
})

/* ---------------- 穿透会话（阶段 2）：状态源切换 / 播种 / 失焦忽略 / 降级 ---------------- */

test('穿透会话：进入时保留状态（不闪），外部光标接管判定', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'), '前提：指针模式下已淡化')

  pet.setClickThroughHover(true)
  assert.ok(pet.stage.classList.contains('is-hovering'), '进入穿透会话不得先清状态（否则会闪一下）')
  assert.equal(pet.isClickThroughHover(), true)

  // 主进程兜底光标（归一化 0..1，相对窗口内容区 240×280）
  pet.setExternalCursor({ nx: 0.5, ny: 0.4 }) // (120, 112) 在矩形内
  assert.ok(pet.stage.classList.contains('is-hovering'), '外部光标落在矩形内 → 保持淡化')
  pet.setExternalCursor({ nx: 0.02, ny: 0.98 }) // (4.8, 274) 在矩形外（左边界 36）
  assert.ok(!pet.stage.classList.contains('is-hovering'), '外部光标落在矩形外 → 取消淡化')
  pet.setExternalCursor({ nx: 0.5, ny: 0.4 })
  assert.ok(pet.stage.classList.contains('is-hovering'))
  pet.setExternalCursor(null)
  assert.ok(!pet.stage.classList.contains('is-hovering'), 'null（不在窗口内/未知）→ 清状态')
})

test('穿透会话：非会话状态下的外部光标一律忽略（不打架）', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  assert.equal(pet.setExternalCursor({ nx: 0.5, ny: 0.4 }), false, '指针模式不接外部来源')
  assert.ok(!pet.stage.classList.contains('is-hovering'))
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'), '指针模式仍由本地事件驱动')
})

test('穿透会话：blur / 页面隐藏不再误清（普通模式保持 v0.2.0 行为）', () => {
  const { pet, container, doc } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  pet.setClickThroughHover(true)

  container.dispatch('win:blur', {})
  assert.ok(pet.stage.classList.contains('is-hovering'), '穿透会话内失焦不得清状态（窗口几乎不会获得焦点）')
  doc.hidden = true
  doc.dispatch('visibilitychange')
  assert.ok(pet.stage.classList.contains('is-hovering'), '穿透会话内页面隐藏不清（由主进程推 null 负责）')

  // pointerleave 仍然复位（转发来的 leave 是可信的「离开」信号）
  container.dispatch('pointerleave', {})
  assert.ok(!pet.stage.classList.contains('is-hovering'), 'pointerleave 在穿透会话内仍要复位')

  // 退出会话 → 失焦复位恢复
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))
  pet.setClickThroughHover(false)
  assert.ok(!pet.stage.classList.contains('is-hovering'), '退出会话要清一次状态')
  container.dispatch('pointermove', pointer(120, 114))
  container.dispatch('win:blur', {})
  assert.ok(!pet.stage.classList.contains('is-hovering'), '回到指针模式后 blur 复位照旧')
  assert.equal(pet.isClickThroughHover(), false)
})

test('穿透会话：退出后重新武装 pointerover（指针静止也能恢复判定）', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  // 先把一次性的 pointerover 吃掉（模拟「加载时已经用过一次」）
  container.dispatch('pointerover', pointer(120, 114))
  container.dispatch('pointerleave', {})
  assert.ok(!pet.stage.classList.contains('is-hovering'))
  container.dispatch('pointerover', pointer(120, 114))
  assert.ok(!pet.stage.classList.contains('is-hovering'), '前提：pointerover 已被消费，再来一次不生效')

  container.dispatch('pointermove', pointer(120, 114))
  pet.setClickThroughHover(true)
  pet.setClickThroughHover(false)
  assert.ok(!pet.stage.classList.contains('is-hovering'), '退出会话要清状态')
  container.dispatch('pointerover', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'), '退出会话后必须重新武装 pointerover，否则指针静止时永远回不来')
})

test('穿透会话：只有「带坐标的指针事件」才算事件源存活证明，且每会话只上报一次', () => {
  let reports = 0
  const { pet, container, doc } = loadPet({ boxes: BOXES })
  pet.onSystemEvent = () => { reports += 1 }

  // 指针模式：不上报
  container.dispatch('pointermove', pointer(120, 114))
  assert.equal(reports, 0, '非穿透会话不该上报')

  pet.setClickThroughHover(true)
  container.dispatch('pointermove', pointer(120, 114))
  assert.equal(reports, 1, '第一个带坐标的事件上报一次')
  container.dispatch('pointermove', pointer(130, 114))
  assert.equal(reports, 1, '同一会话不重复上报（避免 IPC 洪泛）')

  // 无坐标事件（pointerleave）不算证据
  pet.setClickThroughHover(false)
  pet.setClickThroughHover(true)
  container.dispatch('pointerleave', {})
  assert.equal(reports, 1, 'pointerleave 无坐标 → 不算存活证据')

  // 走判定路径但没有坐标的事件（某些合成/转发异常）同样不算
  container.dispatch('pointermove', { target: { closest: () => null } })
  assert.equal(reports, 1, '没有 clientX/clientY 的 pointermove 不算存活证据')

  // 新会话可以再上报一次
  container.dispatch('pointermove', pointer(120, 114))
  assert.equal(reports, 2, '重新进入会话后允许再上报一次')
  doc.hidden = false
})

test('降级：主进程把模式推回 false 后，渲染层恢复指针语义（失焦复位、状态已清）', () => {
  const { pet, container } = loadPet({ boxes: BOXES })
  pet.setClickThroughHover(true)
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))

  // 主进程判定「读不到全局光标」→ 推 { clickThrough: false }
  pet.setClickThroughHover(false)
  assert.ok(!pet.stage.classList.contains('is-hovering'), '降级要清状态（不能卡在淡化）')
  container.dispatch('pointermove', pointer(120, 114))
  container.dispatch('win:blur', {})
  assert.ok(!pet.stage.classList.contains('is-hovering'), '降级后失焦复位恢复可用')
})

test('接线：入口订阅模式/光标并做启动握手，事件上报接到 IPC', () => {
  const src = read('src/renderer/pet-main.js')
  for (const marker of ['getHoverState', 'onHoverMode', 'onHoverCursor', 'reportHoverEvent', 'setClickThroughHover', 'setExternalCursor']) {
    assert.match(src, new RegExp(marker), `pet-main.js 必须接线 ${marker}`)
  }
  const preload = read('src/main/preload.cjs')
  for (const marker of ['onHoverMode', 'onHoverCursor', 'getHoverState', 'reportHoverEvent', 'hover:mode', 'hover:cursor', 'hover:cursor:get', 'hover:event']) {
    assert.match(preload, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `preload.cjs 必须暴露 ${marker}`)
  }
  const main = read('src/main/main.js')
  assert.match(main, /ipcMain\.handle\('hover:cursor:get'/, '主进程要有握手通道')
  assert.match(main, /ipcMain\.on\('hover:event'/, '主进程要接收事件存活证明')
  assert.match(main, /on\('did-finish-load', \(\) => syncHoverMonitor\(\{ resend: true \}\)\)/, '页面加载后要重发模式与光标')
  assert.match(main, /powerPaused = !!paused[\s\S]{0,400}syncHoverMonitor\(\)/, '锁屏/休眠要同步监控')
  assert.match(main, /hoverMonitor\?\.stop\(\)[\s\S]{0,80}endDrag\(\)/, '退出前要停监控（不留定时器）')

  // 配置变更（穿透/缩放/功能开关）后必须重新同步会话
  const applyBody = bodyOf(main, 'function applyWindowConfig(')
  assert.match(applyBody, /syncHoverMonitor\(\)/, 'applyWindowConfig 必须同步穿透悬停会话')
  // 窗口可见性/最小化变化要同步（隐藏/最小化 → 停；恢复 → 按当前光标重新判定）
  for (const ev of ['show', 'hide', 'minimize', 'restore']) {
    assert.match(main, new RegExp(`win\\.on\\('${ev}', \\(\\) => syncHoverMonitor\\(\\)\\)`), `main.js 必须监听 window ${ev}`)
  }
  // 监控器必须注入真实的光标/窗口框/发送（不是空实现）
  const initBody = bodyOf(main, 'function initHoverMonitor(')
  assert.match(initBody, /screen\.getCursorScreenPoint\(\)/, '必须读系统光标')
  assert.match(initBody, /win\.getContentBounds\(\)/, '必须读内容区边界（DIP）')
  assert.match(initBody, /hover:cursor/, '必须推 hover:cursor 通道')
  assert.match(initBody, /supported: HOVER_SUPPORTED/, '必须把平台闸门传给监控器')
  // 会话条件必须走 shouldRunHoverMonitor（Linux → false → 零行为）
  assert.match(bodyOf(main, 'function hoverSessionActive('), /shouldRunHoverMonitor\(/, '会话条件必须走 shouldRunHoverMonitor')
})

/* ---------------- 包装层 / 宽度上限 ---------------- */

test('构造：状态气泡被包进 .pet-status-wrap（包装层负责淡化，气泡保留显隐）', () => {
  const { pet } = loadPet({ boxes: BOXES })
  assert.equal(pet.statusWrap?.className, 'pet-status-wrap')
  assert.ok(pet.statusWrap.children.includes(pet.statusEl), '气泡必须在包装层内')
  assert.ok(pet.stage.children.includes(pet.statusWrap), '包装层必须挂在舞台上')
})

const LONG_TEXT = '推理中 ×3 · KV cache 87% · 12.3 tok/s · qwen2.5-72b-instruct'
const styleWidth = (pet) => Number(String(pet.statusEl.style.width || '').replace('px', ''))
// 前提守卫：字宽必须大到让上限真正起来，否则「布局宽 vs 渲染宽」两种实现会算出同一个数，用例空转
const assertCapBinds = () => {
  const textPx = [...LONG_TEXT].length * 7 + 4
  assert.ok(textPx > 246, `前提：伪排版下文本宽 ${textPx} 必须超过上限，否则区分不出实现`)
}
// 气泡上限公式：max(96, round(cw × 0.72))；style.width = 上限 - 20(padding)
const capStyleWidth = (cw) => Math.max(96, Math.round(cw * 0.72)) - 20

test('气泡宽度上限用容器的**布局宽**（clientWidth），不受祖先 CSS transform 放大', () => {
  assertCapBinds()
  // 预览页：#pet-holder 布局宽 240，被 scale(1.15) 渲染成 276 → 上限必须按 240 算
  const { pet, container } = loadPet({ boxes: { ...BOXES, container: rect(0, 0, 276, 322) } })
  container.clientWidth = 240
  container.clientHeight = 280
  pet.setStatusLine(LONG_TEXT)
  // 上限 = round(240×0.72) = 173 → style.width = 153；误用渲染宽 276 会算成 179（round(276*0.72)-20）
  assert.equal(styleWidth(pet), capStyleWidth(240), '上限必须按布局宽 240 算（173），而不是按渲染宽 276 算（179）')
  assert.equal(styleWidth(pet), 153, '上限 173 - 20 padding = 153')
  assert.ok((styleWidth(pet) + 20) * 1.15 <= 276, '按布局宽算出的气泡在 scale(1.15) 下仍装得进 276 的卡片')
})

test('气泡宽度上限用容器宽（不是整页视口宽）', () => {
  assertCapBinds()
  const { pet } = loadPet({ boxes: { ...BOXES, container: rect(0, 0, 240, 280) } })
  pet.setStatusLine(LONG_TEXT)
  assert.equal(styleWidth(pet), capStyleWidth(240), '上限 = round(240×0.72) - 20 = 153（整页视口宽会算出不受限的大气泡）')
})

test('气泡宽度上限公式：round(cw × 0.72)，下界 96（保证长文字时矩形两侧仍有留白）', () => {
  assertCapBinds()
  for (const [cw, expectBorder] of [[240, 173], [144, 104], [480, 346], [100, 96]]) {
    const { pet } = loadPet({ boxes: { ...BOXES, container: rect(0, 0, cw, 280) } })
    pet.setStatusLine(LONG_TEXT)
    assert.equal(styleWidth(pet) + 20, expectBorder, `cw=${cw} → border 上限应为 ${expectBorder}`)
  }
})

/* ---------------- 容器 resize 失效路径 ---------------- */

test('容器 resize → 命中矩形按新容器重算（不是停在旧位置）', () => {
  const { pet, container, fireResize, resizeObservers } = loadPet({ boxes: BOXES })
  assert.equal(resizeObservers.length, 1, 'resize 观察者只能注册一次')
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'), '前提：初始悬停中')
  const before = pet.getHoverRect()
  assert.equal(pet._hoverRectDirty, false, '前提：resize 前脏标记是干净的 —— 这正是「矩形停在旧位置」的根因')
  assert.equal(before.right, 204, '前提：初始矩形右边界 = 本体 192 + 外扩 12')

  // 外部布局变化：容器缩到 160×180（不改任何几何字段，脏标记不会被置位）
  container.rect = rect(0, 0, 160, 180)
  container.clientWidth = 160
  container.clientHeight = 180
  fireResize()

  assert.equal(pet._hoverRectDirty, false, 'resize 回调必须把矩形重算掉，而不是留着脏标记等下一次指针事件')
  const after = pet.getHoverRect()
  assert.notEqual(after, before, 'resize 后必须重算出新矩形')
  assert.deepEqual(after, { left: 36, top: 5, right: 160, bottom: 180 }, '矩形必须按新容器裁剪（160×180）')

  // 新矩形立刻生效：旧矩形内、新矩形外的点不再命中
  container.dispatch('pointermove', pointer(190, 100))
  assert.ok(!pet.stage.classList.contains('is-hovering'), '缩窗后旧矩形覆盖的区域必须失效（190 > 新宽 160）')
  // 新矩形内仍然命中
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))
})

test('resize 不翻转悬停状态：指针没动，状态就不变（不抖动不变量）', () => {
  const { pet, container, fireResize } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))

  // 容器放大：指针仍在矩形内 → 保持悬停
  container.rect = rect(0, 0, 480, 560)
  container.clientWidth = 480
  container.clientHeight = 560
  fireResize()
  assert.ok(pet.stage.classList.contains('is-hovering'), '放大后仍在矩形内，不得掉状态')

  // 容器缩小到指针之外：resize 本身也不得把状态翻掉（等下一条指针事件才更新）
  container.rect = rect(0, 0, 100, 100)
  container.clientWidth = 100
  container.clientHeight = 100
  fireResize()
  assert.ok(pet.stage.classList.contains('is-hovering'), 'resize 不得翻转悬停状态（状态只随指针输入变化）')
  container.dispatch('pointermove', pointer(10, 90))
  assert.ok(!pet.stage.classList.contains('is-hovering'), '下一条指针事件才按新矩形更新状态（x=10 < 左边界 36）')
})

/* ---------------- 滚动失效路径（预览页卡片在可滚动页面里） ---------------- */

test('页面滚动 120px → 命中矩形跟着上移（不是停在旧位置）', () => {
  const { pet, container, scrollBy, fireScroll } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'), '前提：初始悬停中')
  const before = pet.getHoverRect()
  assert.deepEqual(before, { left: 36, top: 5, right: 204, bottom: 272 }, '前提：初始矩形')

  // 页面向下滚 120：所有客户端矩形同步上移 120，容器尺寸不变（RO 不会回调）
  scrollBy(120)
  assert.equal(pet._hoverRectDirty, false, '前提：滚动不改几何字段，脏标记本来是干净的 —— 缺陷根因')
  fireScroll()

  const after = pet.getHoverRect()
  assert.equal(after.top, before.top - 120, '滚动后矩形上沿必须跟着上移 120（停在旧位置就会错位）')
  assert.deepEqual(after, { left: 36, top: -115, right: 204, bottom: 152 }, '整体上移 120，并按容器新位置裁剪')

  // 上移后才进入矩形的区域（旧矩形外）必须命中；移出矩形的区域（旧矩形内）必须不命中
  container.dispatch('pointermove', pointer(120, -60))
  assert.ok(pet.stage.classList.contains('is-hovering'), '滚动后头部露出的区域必须命中（旧矩形上沿是 5）')
  container.dispatch('pointermove', pointer(120, 200))
  assert.ok(!pet.stage.classList.contains('is-hovering'), '滚动后卡片下方的空白不得误触发（新矩形下沿 160）')
})

test('滚动不翻转悬停状态：指针没动，状态就不变（不抖动不变量）', () => {
  const { pet, container, scrollBy, fireScroll } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  assert.ok(pet.stage.classList.contains('is-hovering'))

  scrollBy(120)
  fireScroll()
  assert.ok(pet.stage.classList.contains('is-hovering'), '滚动本身不得翻转悬停状态（状态只随指针输入变化）')

  // 下一条指针事件才按新矩形更新（指针位置已经落在矩形外）
  container.dispatch('pointermove', pointer(120, 240))
  assert.ok(!pet.stage.classList.contains('is-hovering'))
})

test('无关滚动（目标不在本容器内）不触发重算', () => {
  const { pet, container, boxes, scrollBy, fireScroll } = loadPet({ boxes: BOXES })
  container.dispatch('pointermove', pointer(120, 114))
  const r1 = pet.getHoverRect()
  scrollBy(120)
  fireScroll({ contains: () => false })
  assert.equal(pet.getHoverRect(), r1, '别人的滚动不该重算本矩形的几何')
  assert.deepEqual(boxes.art, rect(48, -103, 192, 105), '前提：世界确实滚了（尺寸没变）')
})

test('resize 同尺寸回调（RO 首次回调）不重算，避免无谓的布局读取', () => {
  const { pet, fireResize } = loadPet({ boxes: BOXES })
  const r1 = pet.getHoverRect()
  fireResize()
  assert.equal(pet.getHoverRect(), r1, '同尺寸时矩形对象应原样复用（identity 相等 = 没有重算）')
})

/* ---------------- 入口接线 ---------------- */

function bodyOf(src, marker) {
  const at = src.indexOf(marker)
  assert.notEqual(at, -1, `找不到 ${marker}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  throw new Error(`${marker} 花括号不配对`)
}

const PET_MAIN = read('src/renderer/pet-main.js')
const PREVIEW_MAIN = read('src/renderer/preview-main.js')

test('pet-main.js / preview-main.js：启动与配置变更各应用一次 hoverFade', () => {
  assert.equal((PET_MAIN.match(/pet\.setHoverFade\(/g) || []).length, 2)
  assert.match(bodyOf(PET_MAIN, 'const applyConfig = async (saved) =>'), /pet\.setHoverFade\(saved\.hoverFade\)/)
  assert.equal((PREVIEW_MAIN.match(/pet\.setHoverFade\(/g) || []).length, 2)
  assert.match(bodyOf(PREVIEW_MAIN, 'onSaved: async (saved) =>'), /pet\.setHoverFade\(saved\.hoverFade\)/)
})

test('pet.js：不再有 .r-hover 告警与「换肤清状态」的旧逻辑', () => {
  const src = read('src/renderer/robot/pet.js')
  assert.doesNotMatch(src, /_warnIfNoHitRegion/, '缺分组不再告警（矩形兜底）')
  assert.doesNotMatch(src, /皮肤缺少 \.r-hover/, '旧告警文案必须删除')
  assert.doesNotMatch(src, /style\.opacity\s*=/, '不得写行内不透明度')
})
