import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const PET = read('src/renderer/robot/pet.js')
const PET_MAIN = read('src/renderer/pet-main.js')
const PREVIEW_MAIN = read('src/renderer/preview-main.js')

/**
 * 取出声明的函数体（按花括号配对切片）。
 * pet.js / pet-main.js / preview-main.js 依赖 Vite 的 ?raw 与 CSS 导入，在 Node 里无法直接
 * import，因此这里对源码做结构性断言：只校验「做了什么」，不校验排版。
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

const SET_HOVER = bodyOf(PET, 'setHoverFade(input) {')
const WARN = bodyOf(PET, '_warnIfNoHitRegion() {')
const APPLY_SKIN = bodyOf(PET, 'applySkin(skin) {')
const PET_MAIN_BOOT = bodyOf(PET_MAIN, 'async function boot() {')
const PREVIEW_BOOT = bodyOf(PREVIEW_MAIN, 'async function boot() {')

test('pet.js 复用共享归一化函数，不自己再写一套规则', () => {
  assert.match(PET, /import \{[^}]*normalizeHoverFade[^}]*\} from '\.\.\/\.\.\/shared\/hover-fade\.js'/)
  assert.match(SET_HOVER, /normalizeHoverFade\(/, 'setHoverFade 必须走 normalizeHoverFade')
})

test('setHoverFade：class 只由开关决定，不透明度只写进 CSS 变量', () => {
  assert.match(SET_HOVER, /classList\.toggle\(\s*'hover-fade-enabled'\s*,\s*enabled\s*\)/, 'class 必须按 enabled 切换')
  assert.match(SET_HOVER, /style\.setProperty\(\s*'--hover-opacity'/, '不透明度必须写进 --hover-opacity')
  assert.doesNotMatch(SET_HOVER, /style\.opacity/, '不得直接写 style.opacity（那样状态机的其它不透明度会被覆盖）')
  assert.doesNotMatch(SET_HOVER, /addEventListener/, '命中判定交给 CSS :hover，不得在这里绑定鼠标事件')
})

test('setHoverFade：只在开启时检查命中区，避免关闭状态下反复告警', () => {
  assert.match(SET_HOVER, /if \(enabled\) this\._warnIfNoHitRegion\(\)/)
})

test('缺 .r-hover 的告警只发一次，并指向皮肤文档', () => {
  assert.match(WARN, /_hoverWarned/, '必须有一次性守卫')
  assert.match(WARN, /querySelector\(\s*'\.r-hover'\s*\)/, '必须检测 .r-hover 是否存在')
  assert.match(WARN, /console\.warn\(/, '缺失时应告警而非抛错')
  assert.match(WARN, /skin|皮肤/i)
  assert.match(WARN, /README\.md/, '告警应指向皮肤文档')
})

test('换肤后重新检查命中区（新皮肤可能没有 .r-hover）', () => {
  assert.match(APPLY_SKIN, /_warnIfNoHitRegion\(\)/, 'applySkin 末尾必须重新检查命中区')
})

test('pet.js 不发鼠标事件、不改窗口透明度（命中与淡化全部交给 CSS）', () => {
  assert.doesNotMatch(PET, /addEventListener\(\s*'mouse(over|enter|move|leave)'/)
  assert.doesNotMatch(PET, /opacity\s*=\s*\d/, '不得用行内不透明度覆盖 CSS')
})

test('pet-main.js：启动时应用一次，配置变更后再次应用', () => {
  const calls = PET_MAIN.match(/pet\.setHoverFade\(/g) || []
  assert.equal(calls.length, 2, `pet-main.js 应有 2 处调用（初始化 + 配置变更），实际 ${calls.length}`)
  assert.match(PET_MAIN_BOOT, /pet\.setHoverFade\(/, 'boot 里必须初始化')
  const applyConfig = bodyOf(PET_MAIN, 'const applyConfig = async (saved) =>')
  assert.match(applyConfig, /pet\.setHoverFade\(saved\.hoverFade\)/, 'applyConfig 必须应用最新配置')
})

test('preview-main.js：启动时应用一次，内嵌面板保存后再次应用', () => {
  const calls = PREVIEW_MAIN.match(/pet\.setHoverFade\(/g) || []
  assert.equal(calls.length, 2, `preview-main.js 应有 2 处调用（初始化 + 保存回调），实际 ${calls.length}`)
  assert.match(PREVIEW_BOOT, /pet\.setHoverFade\(/, 'boot 里必须初始化')
  const onSaved = bodyOf(PREVIEW_MAIN, 'onSaved: async (saved) =>')
  assert.match(onSaved, /pet\.setHoverFade\(saved\.hoverFade\)/, '保存回调必须应用最新配置')
})
