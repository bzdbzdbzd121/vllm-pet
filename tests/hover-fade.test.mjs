import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_HOVER_FADE, normalizeHoverFade } from '../src/shared/hover-fade.js'
import { DEFAULT_CONFIG as MAIN_DEFAULT } from '../src/main/config-store.js'
import { DEFAULT_CONFIG as PREVIEW_DEFAULT } from '../src/renderer/status/providers.js'

const FALLBACK = { enabled: true, opacity: 0.4 }

test('默认：整体缺失或类型不对 → 默认值', () => {
  for (const input of [undefined, null, {}, 'str', 0, []]) {
    assert.deepEqual(normalizeHoverFade(input), FALLBACK, `输入 ${JSON.stringify(input)}`)
  }
})

test('布尔：只有真正的布尔值才被采信', () => {
  assert.equal(normalizeHoverFade({ enabled: true }).enabled, true)
  assert.equal(normalizeHoverFade({ enabled: false }).enabled, false)

  // 非布尔一律回默认（默认开启）：手工写 "false" / 0 / null 关不掉功能
  for (const input of [{ enabled: 'false' }, { enabled: 0 }, { enabled: null }]) {
    assert.equal(normalizeHoverFade(input).enabled, true, `输入 ${JSON.stringify(input)}`)
  }
})

test('数值：正常值原样保留，越界夹到 [0, 1]', () => {
  for (const opacity of [0, 0.05, 0.4, 1]) {
    assert.equal(normalizeHoverFade({ opacity }).opacity, opacity)
  }
  assert.equal(normalizeHoverFade({ opacity: -0.2 }).opacity, 0)
  assert.equal(normalizeHoverFade({ opacity: 1.5 }).opacity, 1)
  assert.equal(normalizeHoverFade({ opacity: '0.6' }).opacity, 0.6)
})

test('畸形 opacity → 默认 0.4（不能因 Number(null) === 0 变成 0）', () => {
  for (const opacity of [null, false, '', '   ', NaN, Infinity]) {
    const label = typeof opacity === 'number' ? String(opacity) : JSON.stringify(opacity)
    assert.equal(normalizeHoverFade({ opacity }).opacity, 0.4, `输入 ${label}`)
  }
})

test('允许全透明：opacity 0 是有效值，不能被当成缺失', () => {
  assert.equal(normalizeHoverFade({ opacity: 0 }).opacity, 0)
})

test('不修改入参', () => {
  const input = { enabled: false, opacity: 1.5 }
  const snapshot = structuredClone(input)
  normalizeHoverFade(input)
  assert.deepEqual(input, snapshot)
})

test('默认常量与返回值：归一化结果落在新对象上，不改动冻结的默认常量', () => {
  assert.deepEqual(DEFAULT_HOVER_FADE, FALLBACK)
  const out = normalizeHoverFade(undefined)
  assert.deepEqual(out, DEFAULT_HOVER_FADE)
  assert.notEqual(out, DEFAULT_HOVER_FADE)
})

test('一致性：主进程与预览页两份默认配置归一化后相同且等于默认值', () => {
  assert.deepEqual(normalizeHoverFade(MAIN_DEFAULT.hoverFade), { enabled: true, opacity: 0.4 })
  assert.deepEqual(normalizeHoverFade(PREVIEW_DEFAULT.hoverFade), DEFAULT_HOVER_FADE)
})
