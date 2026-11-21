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
    setTimeout,
    clearTimeout
  }
  return vm.runInNewContext(`${src}\n;PetView`, sandbox)
}

/** 只在 Node 侧模拟 stage 的三个能力：CSS 变量写入、class 切换、.r-hover 查询 */
function makeStage({ hitRegion = true } = {}) {
  const props = new Map()
  const classes = new Set()
  const stage = {
    hitRegion,
    props,
    classes,
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
  const PetView = loadPetView(warns)
  const stage = makeStage(opts)
  // 只取原型上的真实方法，构造函数依赖 document，不在此使用
  const pet = Object.assign(Object.create(PetView.prototype), {
    skin: { animations: {} },
    state: 'idle',
    stage,
    scaleWrap: { innerHTML: '' },
    shadowWrap: { innerHTML: '' },
    _hoverWarned: false
  })
  return { pet, stage, warns }
}

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

test('setHoverFade：不写内联 style.opacity，也不绑定鼠标事件（淡化交给 CSS）', () => {
  const { pet, stage } = makePet()
  pet.setHoverFade({ enabled: true, opacity: 0.4 })
  assert.equal(stage.style.opacity, undefined, '不得写入 style.opacity')
  assert.equal(stage.addEventListener, undefined, '不得在 stage 上绑定鼠标事件')
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

test('pet.js 不在内部维护鼠标悬停状态，也不写行内不透明度', () => {
  const src = read('src/renderer/robot/pet.js')
  assert.doesNotMatch(src, /addEventListener\(\s*['"]mouse(over|enter|move|leave)/, '不得用鼠标事件自己判定命中')
  assert.doesNotMatch(src, /style\.opacity\s*=/, '不得写行内不透明度')
})
