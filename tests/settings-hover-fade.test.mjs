import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { normalizeHoverFade } from '../src/shared/hover-fade.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/settings-panel.js'), 'utf8')

/**
 * settings-panel.js 依赖 Vite（skin-loader 的 ?raw / .json），Node 里无法直接 import。
 * 这里执行**真实源码**（只把 listAvailableSkins 换成桩），断言纯函数行为与 patch/模板接线。
 * 用 runInThisContext 包成工厂函数：同一 realm 里返回的值才能用 deepEqual 比较。
 */
function loadPanel() {
  let src = SRC.replace(/^import \{[^}]*\} from '\.\.\/skins\/skin-loader\.js'$/m, '')
  src = src.replace(/^import \{[^}]*\} from '\.\.\/\.\.\/shared\/hover-fade\.js'$/m, '')
  src = src.replace(/^export /gm, '')
  const factory = vm.runInThisContext(
    `(function (listAvailableSkins, normalizeHoverFade, document, console) {\n${src}\n` +
      `return { hoverFadeFormState, hoverFadeFromForm, SettingsPanel }\n})`
  )
  const noDom = { createElement: () => { throw new Error('本测试不实例化 DOM') } }
  return factory(async () => [], normalizeHoverFade, noDom, console)
}

const { hoverFadeFormState, hoverFadeFromForm } = loadPanel()

/* ---------------- 回填：config → 表单初值 ---------------- */

test('回填：缺字段时显示「已勾选 + 40%」', () => {
  for (const config of [undefined, {}, { hoverFade: undefined }]) {
    assert.deepEqual(hoverFadeFormState(config), { enabled: true, pct: 40 }, `输入 ${JSON.stringify(config)}`)
  }
})

test('回填：0 显示 0（不能被当成缺失而跳回 40）', () => {
  assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity: 0 } }), { enabled: true, pct: 0 })
  assert.deepEqual(hoverFadeFormState({ hoverFade: { enabled: false, opacity: 0 } }), { enabled: false, pct: 0 })
})

test('回填：合法值取整到百分比，越界/畸形按归一化处理', () => {
  assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity: 0.25 } }), { enabled: true, pct: 25 })
  assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity: '0.6' } }), { enabled: true, pct: 60 })
  assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity: 1 } }), { enabled: true, pct: 100 })
  assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity: 1.5 } }), { enabled: true, pct: 100 })
  assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity: -0.2 } }), { enabled: true, pct: 0 })
  for (const opacity of [null, '', '  ', NaN, Infinity, false]) {
    assert.deepEqual(hoverFadeFormState({ hoverFade: { opacity } }), { enabled: true, pct: 40 }, `opacity=${String(opacity)}`)
  }
})

test('回填：非布尔 enabled 一律按开启显示', () => {
  for (const enabled of ['false', 0, null]) {
    assert.equal(hoverFadeFormState({ hoverFade: { enabled } }).enabled, true, `enabled=${String(enabled)}`)
  }
  assert.equal(hoverFadeFormState({ hoverFade: { enabled: false } }).enabled, false)
})

/* ---------------- 保存：表单 → config 值 ---------------- */

test('保存：百分比换算成 0–1，0% 必须保留为 0', () => {
  assert.deepEqual(hoverFadeFromForm({ enabled: true, opacityRaw: '40' }, {}), { enabled: true, opacity: 0.4 })
  assert.deepEqual(hoverFadeFromForm({ enabled: true, opacityRaw: '0' }, {}), { enabled: true, opacity: 0 })
  assert.deepEqual(hoverFadeFromForm({ enabled: false, opacityRaw: '0' }, {}), { enabled: false, opacity: 0 })
  assert.deepEqual(hoverFadeFromForm({ enabled: true, opacityRaw: '5' }, {}), { enabled: true, opacity: 0.05 })
  assert.deepEqual(hoverFadeFromForm({ enabled: true, opacityRaw: '100' }, {}), { enabled: true, opacity: 1 })
})

test('保存：越界百分比夹到 0–1，空白/非法回退到当前配置（不静默改回 0.4）', () => {
  const cfg = { hoverFade: { opacity: 0.7 } }
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: '-20' }, cfg).opacity, 0)
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: '150' }, cfg).opacity, 1)
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: '' }, cfg).opacity, 0.7)
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: '   ' }, cfg).opacity, 0.7)
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: 'abc' }, cfg).opacity, 0.7)
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: null }, cfg).opacity, 0.7)
  // 配置本身畸形时回退到默认 0.4
  assert.equal(hoverFadeFromForm({ enabled: true, opacityRaw: '' }, { hoverFade: { opacity: 'x' } }).opacity, 0.4)
})

test('保存：只清洗输入，不修改入参，且每次返回新对象', () => {
  const input = { enabled: true, opacityRaw: '40' }
  const out = hoverFadeFromForm(input, {})
  assert.deepEqual(out, { enabled: true, opacity: 0.4 })
  assert.notEqual(out, input)
  assert.equal(input.opacityRaw, '40')
  assert.equal(hoverFadeFromForm({ enabled: 'true', opacityRaw: '40' }, {}).enabled, false, '只认同真布尔 true')
})

test('保存/回填闭环：不改动直接保存，结果等于归一化后的原配置', () => {
  for (const opacity of [0, 0.05, 0.25, 0.4, 0.7, 1]) {
    for (const enabled of [true, false]) {
      const config = { hoverFade: { enabled, opacity } }
      const form = hoverFadeFormState(config)
      const saved = hoverFadeFromForm({ enabled: form.enabled, opacityRaw: String(form.pct) }, config)
      assert.deepEqual(saved, normalizeHoverFade(config.hoverFade), `opacity=${opacity} enabled=${enabled}`)
    }
  }
  // 配置缺字段：不改动保存仍是默认
  const form = hoverFadeFormState({})
  assert.deepEqual(hoverFadeFromForm({ enabled: form.enabled, opacityRaw: String(form.pct) }, {}), { enabled: true, opacity: 0.4 })
})

/* ---------------- 界面接线（DOM 模板 / patch 白名单） ---------------- */

test('模板：开关 + 0–100 步进 5 的滑块 + 实时百分比 + 「悬停时不透明度」标签', () => {
  assert.match(SRC, /name="hoverFadeEnabled"/, '缺少开关控件')
  assert.match(SRC, /name="hoverFadeOpacity"/, '缺少滑块控件')
  assert.match(SRC, /<input type="range" name="hoverFadeOpacity" min="0" max="100" step="5"/, '滑块范围/步进不对（须 0–100，step 5）')
  assert.match(SRC, /id="hoverFadePct"/, '缺少百分比显示节点')
  assert.match(SRC, /悬停时不透明度/, '标签文案缺失或语义不清')
  assert.match(SRC, /hoverFadeFormState\(/, '模板必须用 hoverFadeFormState 回填，不能自己再算一遍')
})

test('滑块联动：input 事件实时更新百分比', () => {
  const at = SRC.indexOf("addEventListener('input'")
  assert.notEqual(at, -1, '滑块必须监听 input 事件')
  const block = SRC.slice(Math.max(0, at - 200), SRC.indexOf('})', at) + 2)
  assert.match(block, /hoverFadeOpacity/, 'input 监听必须绑在滑块 hoverFadeOpacity 上')
  assert.match(block, /#hoverFadePct/, 'input 回调必须更新 #hoverFadePct')
  assert.match(block, /e\.target\.value/, '必须用滑块的实际值刷新百分比')
})

test('保存 patch：顶层写入 hoverFade，且走 hoverFadeFromForm（不用 num() 的 >0 兜底）', () => {
  const at = SRC.indexOf('const patch = {')
  assert.notEqual(at, -1, '找不到保存 patch')
  const body = SRC.slice(at, SRC.indexOf('\n      }', at) + 8)
  assert.match(body, /^\s*hoverFade: /m, 'patch 顶层必须包含 hoverFade（显式白名单，漏了就是"保存成功但不生效"）')
  assert.match(body, /hoverFadeFromForm\(/, 'hoverFade 值必须由 hoverFadeFromForm 计算')
  assert.match(body, /get\('hoverFadeEnabled'\)\.checked/, '必须读取开关的实际状态')
  assert.match(body, /get\('hoverFadeOpacity'\)\.value/, '必须读取滑块的实际值')
  // 「0 是有效值」的关键：不能拿 num() 解析这个字段
  assert.doesNotMatch(body, /hoverFade:[\s\S]*?num\('hoverFade/, 'hoverFade 不得使用 num()（会把 0 静默改成默认值）')
})

test('滑块样式：robot.css 覆盖 range 输入', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/robot/robot.css'), 'utf8')
  assert.match(css, /\.pet-settings input\[type="range"\]\s*\{[^}]*width:\s*100%/, '滑块缺宽度样式')
  assert.match(css, /\.pet-settings input\[type="range"\]\s*\{[^}]*accent-color/, '滑块缺主题色样式')
})
