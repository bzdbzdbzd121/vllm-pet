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

function loadPet({ boxes = {}, showStatus = true, statusText = '空闲中', warn = () => {} } = {}) {
  const handlers = new Map()
  const container = makeEl({ rect: boxes.container || rect(0, 0, 240, 280) })
  container.addEventListener = (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, [])
    handlers.get(type).push(fn)
  }
  container.dispatch = (type, event) => (handlers.get(type) || []).forEach((fn) => fn(event))

  const win = { addEventListener: (t, fn) => { handlers.set(`win:${t}`, [fn]) } }
  const doc = {
    hidden: false,
    addEventListener: (t, fn) => { handlers.set(`doc:${t}`, [fn]) },
    createElement: () => makeEl(),
    head: { append: () => {} },
    body: { append: () => {} },
    dispatch: (t) => (handlers.get(`doc:${t}`) || []).forEach((fn) => fn({}))
  }
  const sandbox = {
    applySkinToStage: () => {},
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
  return { pet, container, doc, win }
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

test('矩形算法：union → 外扩 12×缩放 → 裁剪到容器', () => {
  const { pet } = loadPet({ boxes: BOXES })
  assert.deepEqual(pet.getHoverRect(), { left: 36, top: 5, right: 204, bottom: 280 })
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

/* ---------------- 包装层 / 宽度上限 ---------------- */

test('构造：状态气泡被包进 .pet-status-wrap（包装层负责淡化，气泡保留显隐）', () => {
  const { pet } = loadPet({ boxes: BOXES })
  assert.equal(pet.statusWrap?.className, 'pet-status-wrap')
  assert.ok(pet.statusWrap.children.includes(pet.statusEl), '气泡必须在包装层内')
  assert.ok(pet.stage.children.includes(pet.statusWrap), '包装层必须挂在舞台上')
})

test('气泡宽度上限用容器的**布局宽**（clientWidth），不受祖先 CSS transform 放大', () => {
  // 预览页：容器渲染宽 276（= 240 × scale(1.15)），布局宽仍是 240 → 上限必须按 240 算
  const { pet, container } = loadPet({ boxes: { ...BOXES, container: rect(0, 0, 276, 322) } })
  container.clientWidth = 240
  pet.setStatusLine('推理中 ×3 · KV cache 87% · 12.3 tok/s · qwen2.5-72b-instruct')
  const width = Number(String(pet.statusEl.style.width || '').replace('px', ''))
  assert.ok(width <= 210, `按布局宽 240 计时上限应为 210，实际 ${width}（按渲染宽 276 会算成 246 → 渲染后溢出卡片）`)
})

test('气泡宽度上限用容器宽（不是整页视口宽）', () => {
  const { pet } = loadPet({ boxes: { ...BOXES, container: rect(0, 0, 240, 280) } })
  pet.setStatusLine('推理中 ×3 · KV cache 87% · 12.3 tok/s · qwen2.5-72b-instruct')
  const width = Number(String(pet.statusEl.style.width || '').replace('px', ''))
  assert.ok(width > 0 && width <= 210, `宽度应被容器上限约束（≤ 240-10-20=210），实际 ${width}`)
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
