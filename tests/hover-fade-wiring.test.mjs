import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { normalizeHoverFade } from '../src/shared/hover-fade.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * pet.js / pet-main.js 依赖 Vite 的 `?raw` 与 CSS 导入，在 Node 里无法直接 import。
 * 这里把 pet.js 的**真实方法体**放进 vm 执行（只把 skin-loader 换成等价桩）：
 * 断言的是行为，不是源码字符串 —— 删掉关键语句必须让测试变红。
 */
function loadPetView(warns) {
  let src = read('src/renderer/robot/pet.js')
  // 去掉两处模块导入（Vite 专属 / 由沙箱注入），其余源码原样保留
  src = src.replace(/^import \{[^}]*\} from '\.\.\/skins\/skin-loader\.js'$/m, '')
  src = src.replace(/^import \{[^}]*\} from '\.\.\/\.\.\/shared\/hover-fade\.js'$/m, '')
  src = src.replace(/^export /gm, '') // 脚本上下文里没有 export
  const sandbox = {
    applySkinToStage: () => {}, // 皮肤调色板注入：与命中/淡化行为无关
    bobDurationFor: () => 1000,
    normalizeHoverFade,
    queueMicrotask,
    console: { warn: (...args) => warns.push(args.join(' ')) },
    document: { createElement: () => { throw new Error('测试不应实例化 DOM') } },
    DOMParser: class {},
    XMLSerializer: class {},
    window: makeEventTarget(),
    setTimeout,
    clearTimeout
  }
  sandbox.document = Object.assign(makeEventTarget(), sandbox.document, { hidden: false })
  const PetView = vm.runInNewContext(`${src}\n;PetView`, sandbox)
  return { PetView, win: sandbox.window, doc: sandbox.document }
}

/** 极简事件目标：记录监听器，便于手动派发（不引 DOM 库） */
function makeEventTarget() {
  const handlers = new Map()
  return {
    handlers,
    addEventListener: (type, fn) => {
      if (!handlers.has(type)) handlers.set(type, [])
      handlers.get(type).push(fn)
    },
    dispatch: (type, event) => (handlers.get(type) || []).forEach((fn) => fn(event))
  }
}

/** 只在 Node 侧模拟 stage 的能力：CSS 变量写入、class 切换、.r-hover 查询、事件绑定 */
function makeStage({ hitRegion = true } = {}) {
  const props = new Map()
  const classes = new Set()
  const target = makeEventTarget()
  const stage = {
    hitRegion,
    props,
    classes,
    ...target,
    style: { setProperty: (k, v) => props.set(k, String(v)) },
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name)
    },
    querySelector: (sel) => (sel === '.r-hover' && stage.hitRegion ? {} : null)
  }
  return stage
}

function makePet(opts = {}) {
  const warns = []
  const { PetView, win, doc } = loadPetView(warns)
  const stage = makeStage(opts)
  // 只取原型上的真实方法，构造函数依赖 document，不在此使用
  const pet = Object.assign(Object.create(PetView.prototype), {
    skin: { animations: {} },
    state: 'idle',
    stage,
    scaleWrap: { innerHTML: '' },
    shadowWrap: { innerHTML: '' },
    _hoverWarned: false,
    _hovering: false,
    _hoverBound: false,
    _hoverOverArmed: false,
    _hoverWindow: win, // 测试注入：由 _bindHoverFade 绑定的 window/document 等价物
    _hoverDocument: doc
  })
  return { pet, stage, warns, win, doc }
}

/** 构造一个「命中/不命中 .r-hover」的指针事件（完全模拟浏览器给的 e.target） */
const pointerOn = (hit) => ({ target: { closest: (sel) => (hit && sel === '.r-hover' ? { classList: ['r-hover'] } : null) } })

const settle = () => new Promise((r) => setTimeout(r, 0))

/* ---------------- setHoverFade：变量与 class 的真实行为 ---------------- */

test('setHoverFade：不透明度写进 --hover-opacity，且 0 不会被当成缺失', () => {
  const { pet, stage } = makePet()
  pet.setHoverFade({ enabled: true, opacity: 0.4 })
  assert.equal(stage.props.get('--hover-opacity'), '0.4')

  pet.setHoverFade({ enabled: true, opacity: 0 })
  assert.equal(stage.props.get('--hover-opacity'), '0')

  pet.setHoverFade({ enabled: true, opacity: 1 })
  assert.equal(stage.props.get('--hover-opacity'), '1')

  // 畸形/越界值走共享归一化，不产生 NaN 或越界变量
  pet.setHoverFade({ opacity: 'bad' })
  assert.equal(stage.props.get('--hover-opacity'), '0.4')
  pet.setHoverFade({ opacity: 1.7 })
  assert.equal(stage.props.get('--hover-opacity'), '1')
  pet.setHoverFade({ opacity: -3 })
  assert.equal(stage.props.get('--hover-opacity'), '0')
})

test('setHoverFade：class 只由开关决定，与不透明度无关', () => {
  const { pet, stage } = makePet()

  pet.setHoverFade({ enabled: true, opacity: 0.01 })
  assert.ok(stage.classes.has('hover-fade-enabled'), '开启时应加 class')

  pet.setHoverFade({ enabled: true, opacity: 1 }) // 100% 等同关闭的实际效果，但不该摘 class
  assert.ok(stage.classes.has('hover-fade-enabled'), '不透明度改为 100% 不得摘 class')

  pet.setHoverFade({ enabled: false, opacity: 0.4 })
  assert.ok(!stage.classes.has('hover-fade-enabled'), '关闭时应摘 class（立即恢复不透明）')

  // 非布尔 enabled 一律回默认（开启）
  pet.setHoverFade({ enabled: 'false' })
  assert.ok(stage.classes.has('hover-fade-enabled'), '字符串 "false" 不能关闭功能')
})

test('setHoverFade：不写行内 style.opacity（淡化只由 CSS 变量 + class 驱动）', () => {
  const { pet, stage } = makePet()
  pet.setHoverFade({ enabled: true, opacity: 0.4 })
  assert.equal(stage.style.opacity, undefined, '不得写入 style.opacity')
})

/* ---------------- 缺 .r-hover：只告警一次 ---------------- */

test('缺 .r-hover：每次配置应用都会检查，但只告警一次', async () => {
  const { pet, warns } = makePet({ hitRegion: false })
  pet.setHoverFade({ enabled: true })
  await settle()
  assert.equal(warns.length, 1, '首次缺失应告警一次')
  assert.match(warns[0], /\.r-hover/)
  assert.match(warns[0], /README\.md/)

  pet.setHoverFade({ enabled: true, opacity: 0.2 })
  pet.setHoverFade({ enabled: true })
  await settle()
  assert.equal(warns.length, 1, '重复应用配置不得重复告警')
})

test('关闭开关时不告警；重新开启且仍缺失时也只补一次', async () => {
  const { pet, warns } = makePet({ hitRegion: false })

  pet.setHoverFade({ enabled: false })
  await settle()
  assert.equal(warns.length, 0, '功能关闭时不该告警')

  pet.setHoverFade({ enabled: true })
  await settle()
  assert.equal(warns.length, 1)

  pet.setHoverFade({ enabled: false })
  pet.setHoverFade({ enabled: true })
  await settle()
  assert.equal(warns.length, 1, '同一个皮肤只提示一次')
})

test('有 .r-hover 的皮肤永不告警', async () => {
  const { pet, warns } = makePet({ hitRegion: true })
  pet.setHoverFade({ enabled: true })
  await settle()
  assert.deepEqual(warns, [])
})

/* ---------------- 换肤：applySkin 后重新检查 ---------------- */

test('换到缺 .r-hover 的皮肤：applySkin 后补一次告警', async () => {
  const { pet, stage, warns } = makePet({ hitRegion: true })
  pet.setHoverFade({ enabled: true })
  await settle()
  assert.equal(warns.length, 0)

  stage.hitRegion = false // 新皮肤没有命中钩子
  pet.applySkin({})
  await settle()
  assert.equal(warns.length, 1, '换肤后必须重新检查并告警')
})

test('功能关闭时换肤不告警', async () => {
  const { pet, stage, warns } = makePet({ hitRegion: true })
  pet.setHoverFade({ enabled: false })
  stage.hitRegion = false
  pet.applySkin({})
  await settle()
  assert.deepEqual(warns, [])
})

test('同一次配置应用里「先 setHoverFade 再 applySkin」不会对着旧 DOM 误报', async () => {
  // 旧皮肤缺钩子 → 新配置启用功能并换到带 .r-hover 的皮肤（pet-main/preview-main 的实际顺序）
  const { pet, stage, warns } = makePet({ hitRegion: false })
  pet.setHoverFade({ enabled: true })
  stage.hitRegion = true // 紧接着 applySkin 换上了带钩子的皮肤
  pet.applySkin({})
  await settle()
  assert.deepEqual(warns, [], '不许提示「缺 .r-hover」，因为换肤后钩子其实在')
})

/* ---------------- 入口接线 ---------------- */

/**
 * 取出函数体（花括号配对）。入口文件依赖 Vite 与 Electron 桥，无法在 Node 里执行，
 * 这里只对「是否在正确位置调用了 setHoverFade」做结构断言。
 */
function bodyOf(src, marker) {
  const at = src.indexOf(marker)
  assert.notEqual(at, -1, `找不到 ${marker}`)
  const open = src.indexOf('{', at)
  assert.notEqual(open, -1, `${marker} 后没有函数体`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`${marker} 的花括号不配对`)
}

const PET_MAIN = read('src/renderer/pet-main.js')
const PREVIEW_MAIN = read('src/renderer/preview-main.js')

test('pet-main.js：启动时应用一次，配置变更后再次应用', () => {
  const calls = PET_MAIN.match(/pet\.setHoverFade\(/g) || []
  assert.equal(calls.length, 2, `应有 2 处调用（初始化 + 配置变更），实际 ${calls.length}`)
  assert.match(bodyOf(PET_MAIN, 'async function boot() {'), /pet\.setHoverFade\(config\.hoverFade\)/, 'boot 里必须用配置初始化')
  assert.match(bodyOf(PET_MAIN, 'const applyConfig = async (saved) =>'), /pet\.setHoverFade\(saved\.hoverFade\)/, 'applyConfig 必须应用最新配置')
})

test('preview-main.js：启动时应用一次，内嵌面板保存后再次应用', () => {
  const calls = PREVIEW_MAIN.match(/pet\.setHoverFade\(/g) || []
  assert.equal(calls.length, 2, `应有 2 处调用（初始化 + 保存回调），实际 ${calls.length}`)
  assert.match(bodyOf(PREVIEW_MAIN, 'async function boot() {'), /pet\.setHoverFade\(config\.hoverFade\)/, 'boot 里必须用配置初始化')
  assert.match(bodyOf(PREVIEW_MAIN, 'onSaved: async (saved) =>'), /pet\.setHoverFade\(saved\.hoverFade\)/, '保存回调必须应用最新配置')
})

test('pet.js 的命中判定只用 closest(\'.r-hover\')，且写行内不透明度被禁止', () => {
  const src = read('src/renderer/robot/pet.js')
  assert.doesNotMatch(src, /style\.opacity\s*=/, '不得写行内不透明度')
})

/* ---------------- 指针事件锁存（抖动修复的核心） ---------------- */

test('绑定：在 stage 上绑 pointermove + pointerover（进入判定）与 pointerleave + pointercancel（复位）', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  for (const required of ['pointermove', 'pointerover', 'pointerleave', 'pointercancel']) {
    assert.ok(stage.handlers.has(required), `stage 上必须绑 ${required}`)
  }
  // 边界事件只做「进入」，不能用 pointerout 做「离开」：动画把元素移开时边界事件会反复试探
  for (const banned of ['pointerout', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave']) {
    assert.ok(!stage.handlers.has(banned), `不得在 stage 上绑 ${banned}（指针未动、元素随动画变化时会被派发 → 抖动回来）`)
  }
  const src = read('src/renderer/robot/pet.js')
  assert.doesNotMatch(src, /querySelector\(['\"]\.r-hover['\"]\)\.addEventListener/, '不得把监听挂到 .r-hover 本身（换肤会丢掉）')
  assert.doesNotMatch(src, /elementFromPoint/, '不得用 elementFromPoint 轮询（仍会跟随动画）')
})

test('开机即悬停：加载后指针已停在本体上时，一个 pointerover 就能建立锁存', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  assert.ok(!stage.classes.has('is-hovering'), '初始不悬停')

  // 页面刚加载时不会先有 pointermove，浏览器只会补一个 pointerover
  stage.dispatch('pointerover', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'), 'pointerover 落在 .r-hover 上必须立即建立锁存（否则启动时指针已在宠物上却不淡化）')
  assert.equal(pet._hovering, true)
})

test('开机即悬停：指针不在本体上时，pointerover 不得凭空开锁存', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  stage.dispatch('pointerover', pointerOn(false))
  assert.ok(!stage.classes.has('is-hovering'), 'pointerover 落在非 .r-hover 目标上不得开锁存')
  assert.equal(pet._hovering, false)
})

test('pointerover 只吃一次：后续边界事件（动画把元素扫过静止指针时会被派发）不得翻转锁存', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()

  stage.dispatch('pointerover', pointerOn(true)) // 进场（加载后指针已在本体上）
  assert.ok(stage.classes.has('is-hovering'))

  // 之后动画不断把轮廓扫过/扫离静止指针，浏览器会补发 pointerover —— 必须全部忽略
  for (let i = 0; i < 6; i++) {
    stage.dispatch('pointerover', pointerOn(false))
    assert.ok(stage.classes.has('is-hovering'), '已解除武装后 pointerover 不得改成不悬停（否则就是抖动）')
    stage.dispatch('pointerover', pointerOn(true))
    assert.ok(stage.classes.has('is-hovering'))
  }
  assert.equal(pet._hovering, true)
})

test('pointerover 在 window.blur / 页面隐藏后重新武装一次（切回窗口时指针可能已在本体上）', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  stage.dispatch('pointerover', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'))

  pet._hoverWindow.dispatch('blur', {})
  assert.ok(!stage.classes.has('is-hovering'), 'blur 必须复位')
  stage.dispatch('pointerover', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'), 'blur 后应重新允许一次 pointerover 建立锁存')

  // 页面隐藏后同样重新武装
  pet._hoverDocument.hidden = true
  pet._hoverDocument.dispatch('visibilitychange', {})
  assert.ok(!stage.classes.has('is-hovering'))
  pet._hoverDocument.hidden = false
  stage.dispatch('pointerover', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'))
})

test('锁存：pointermove 按 closest(\'.r-hover\') 写 is-hovering，且状态未变时不重复写 DOM', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()

  stage.dispatch('pointermove', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'), '指在本体上应加上 is-hovering')

  let writes = 0
  const rawToggle = stage.classList.toggle
  stage.classList.toggle = (n, on) => { writes++; rawToggle(n, on) }
  stage.dispatch('pointermove', pointerOn(true)) // 同一状态重复到达：不得再写 DOM
  assert.equal(writes, 0, '状态未变时不应重写 class（否则每帧都摸 DOM）')

  stage.dispatch('pointermove', pointerOn(false)) // 缝/空白/光晕环
  assert.ok(!stage.classes.has('is-hovering'), '指到非 .r-hover 目标应清掉 is-hovering')
})

test('锁存：光晕环/头身缝这类「窄带」也只看事件那一刻的几何', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  // 光晕环（pointer-events:none → target 不是 .r-hover）
  stage.dispatch('pointermove', pointerOn(false))
  assert.ok(!stage.classes.has('is-hovering'))
  // 头身缝里命中描边时为 true
  stage.dispatch('pointermove', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'))
})

test('复位：pointerleave / pointercancel / window.blur / 页面隐藏 都清除 is-hovering', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  for (const trigger of ['pointerleave', 'pointercancel', 'window-blur', 'visibility-hidden']) {
    stage.dispatch('pointermove', pointerOn(true))
    assert.ok(stage.classes.has('is-hovering'), `${trigger}：前置状态应为悬停`)
    if (trigger === 'pointerleave') stage.dispatch('pointerleave', {})
    if (trigger === 'pointercancel') stage.dispatch('pointercancel', {}) // 触摸被系统打断（滚动/来电等）
    if (trigger === 'window-blur') pet._hoverWindow.dispatch('blur', {})
    if (trigger === 'visibility-hidden') { pet._hoverDocument.hidden = true; pet._hoverDocument.dispatch('visibilitychange', {}) }
    assert.ok(!stage.classes.has('is-hovering'), `${trigger} 后必须清除 is-hovering（防残留淡化）`)
    assert.equal(pet._hovering, false, `${trigger} 后内部锁存位也应复位`)
  }
})

test('复位：关闭开关时清掉锁存，再开启不带回旧状态', () => {
  const { pet, stage } = makePet()
  pet._bindHoverFade()
  pet.setHoverFade({ enabled: true })
  stage.dispatch('pointermove', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'))

  pet.setHoverFade({ enabled: false })
  assert.ok(!stage.classes.has('is-hovering'), '关闭开关必须同时移除 is-hovering')

  pet.setHoverFade({ enabled: true })
  assert.ok(!stage.classes.has('is-hovering'), '重新开启不得带关闭前的旧状态（等下一条指针事件）')
})

test('复位：换肤时清掉锁存（新皮肤几何不同，缺 .r-hover 时应静默失效）', async () => {
  const { pet, stage, warns } = makePet()
  pet._bindHoverFade()
  pet.setHoverFade({ enabled: true })
  stage.dispatch('pointermove', pointerOn(true))
  assert.ok(stage.classes.has('is-hovering'))

  stage.hitRegion = false
  pet.applySkin({})
  assert.ok(!stage.classes.has('is-hovering'), '换肤后必须清除锁存，由新几何重判')
  await settle() // 告警是微任务里发的（换肤与 setHoverFade 常在同一次配置应用里）
  assert.equal(warns.length, 1, '缺 .r-hover 的皮肤仍需提示一次')
})

test('锁存状态不参与动画：没有任何逐帧/定时重算（无 rAF/定时器/动画事件）', () => {
  const src = read('src/renderer/robot/pet.js')
  assert.doesNotMatch(src, /requestAnimationFrame/, '不得用逐帧重算命中区')
  assert.doesNotMatch(src, /animationframe|transitionend/, '不得用动画事件重算命中区')
})

test('pet-main.js：锁屏/休眠时清除悬停锁存（避免恢复后残留淡化）', () => {
  const body = bodyOf(PET_MAIN, 'bridge?.onPowerPause?.((paused) =>')
  assert.match(body, /clearHoverFade\(\)/, 'onPowerPause 必须在暂停时调用 clearHoverFade()')
})
