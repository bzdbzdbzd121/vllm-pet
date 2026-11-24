import test from 'node:test'
import assert from 'node:assert/strict'
import {
  unionRect,
  padRect,
  clampRect,
  containsPoint,
  hoverPad,
  computeHoverRect,
  normalizePoint
} from '../src/shared/hover-region.js'

const r = (left, top, right, bottom) => ({ left, top, right, bottom })

test('union：多矩形取并集，忽略 null；全空返回 null', () => {
  assert.deepEqual(unionRect(r(10, 20, 30, 40), r(0, 25, 15, 60)), r(0, 20, 30, 60))
  assert.deepEqual(unionRect(null, r(1, 2, 3, 4), undefined), r(1, 2, 3, 4))
  assert.equal(unionRect(null, undefined), null)
})

test('union：不修改入参，返回新对象', () => {
  const a = r(10, 10, 20, 20)
  const b = r(15, 15, 30, 30)
  const out = unionRect(a, b)
  assert.deepEqual(a, r(10, 10, 20, 20))
  assert.deepEqual(b, r(15, 15, 30, 30))
  assert.notEqual(out, a)
})

test('pad：四周外扩 / 内缩，null 透传', () => {
  assert.deepEqual(padRect(r(10, 10, 20, 20), 5), r(5, 5, 25, 25))
  assert.deepEqual(padRect(r(10, 10, 20, 20), -3), r(13, 13, 17, 17))
  assert.equal(padRect(null, 5), null)
})

test('hoverPad：12 × 缩放，缩放夹在 [0.5, 2]，非法值按 1', () => {
  assert.equal(hoverPad(1), 12)
  assert.equal(hoverPad(0.6), 7.2)
  assert.equal(hoverPad(2), 24)
  assert.equal(hoverPad(0.2), 6) // 夹到 0.5
  assert.equal(hoverPad(5), 24) // 夹到 2
  assert.equal(hoverPad(undefined), 12)
  assert.equal(hoverPad(0), 12)
  assert.equal(hoverPad('x'), 12)
})

test('clamp：裁剪到容器；无容器则原样返回', () => {
  assert.deepEqual(clampRect(r(-10, -10, 300, 300), r(0, 0, 240, 280)), r(0, 0, 240, 280))
  assert.deepEqual(clampRect(r(10, 10, 20, 20), r(0, 0, 240, 280)), r(10, 10, 20, 20))
  assert.equal(clampRect(null, r(0, 0, 1, 1)), null)
  assert.deepEqual(clampRect(r(10, 10, 20, 20), null), r(10, 10, 20, 20))
})

test('containsPoint：闭区间（边界算命中），null 不算命中', () => {
  const rect = r(10, 20, 30, 40)
  assert.equal(containsPoint(rect, 10, 20), true, '左上角')
  assert.equal(containsPoint(rect, 30, 40), true, '右下角')
  assert.equal(containsPoint(rect, 20, 30), true)
  assert.equal(containsPoint(rect, 9.9, 30), false)
  assert.equal(containsPoint(rect, 30.1, 30), false)
  assert.equal(containsPoint(null, 20, 30), false)
})

test('computeHoverRect：本体/阴影外扩 → 并入文字原盒 → 裁剪（顺序不可换）', () => {
  const art = r(48, 17, 192, 225)
  const shadow = r(76, 223, 164, 241)
  const status = r(92, 248, 149, 272)
  const container = r(0, 0, 240, 280)
  const rect = computeHoverRect({ art, shadow, status }, container, 1)
  // 本体/阴影并集 = (48,17,192,241)；外扩 12 → (36,5,204,253)；并入文字原盒 (92,248,149,272)
  // → (36,5,204,272)；裁剪到容器不变。**文字不加外扩**：底边停在 272（不是 280）。
  assert.deepEqual(rect, r(36, 5, 204, 272))
})

test('computeHoverRect：状态文字不加外扩（加了会吃掉窗口底部留白 → 从文字移开恢复不了）', () => {
  const container = r(0, 0, 240, 280)
  const art = r(48, 17, 192, 225)
  // 文字底 272 = 窗底 280 之上 8px：矩形底必须还是 272（旧实现会算成 284 → 裁到 280）
  const rect = computeHoverRect({ art, status: r(86, 247, 154, 272) }, container, 1)
  assert.equal(rect.bottom, 272, '底边 = 文字原盒底边，不得被外扩拉到窗口底')
  assert.equal(containsPoint(rect, 120, 274), false, '文字下方 2px（窗口内）已不命中')
  assert.equal(containsPoint(rect, 120, 271), true, '文字盒内仍命中')
})

test('computeHoverRect：长文字（近满窗宽）时矩形两侧仍留白，不退化成整窗', () => {
  const container = r(0, 0, 240, 280)
  const art = r(48, 19, 192, 224)
  // 修法后的气泡上限 = round(240*0.72) = 173 → 文字盒约 33.5..206.5
  const status = r(33.5, 231, 206.5, 272)
  const rect = computeHoverRect({ art, status }, container, 1)
  // 本体两侧外扩后是 36..204，文字盒 33.5..206.5 更宽 → 取文字盒的边，**且不再外扩**
  assert.equal(rect.left, 33.5, '左边界取文字原盒左边缘（旧实现在此会再减 12）')
  assert.equal(rect.right, 206.5, '右边界取文字原盒右边缘（旧实现在此会再加 12）')
  assert.ok(rect.left - container.left >= 6 && container.right - rect.right >= 6, '两侧留白 ≥6px')
  assert.equal(containsPoint(rect, 32, 260), false, '文字左侧 1.5px 已不命中（旧实现会命中）')
})

test('computeHoverRect：缺阴影/缺文字时只用现有项；全缺时退回容器', () => {
  const container = r(0, 0, 240, 280)
  assert.deepEqual(computeHoverRect({ art: r(100, 100, 140, 140) }, container, 1), r(88, 88, 152, 152))
  assert.deepEqual(computeHoverRect({}, container, 1), container, '全缺 → 容器兜底')
  assert.equal(computeHoverRect({}, null, 1), null)
})

test('computeHoverRect：缩放影响外扩量（0.6 → 7.2，2 → 24）', () => {
  const container = r(0, 0, 480, 560)
  const art = r(100, 100, 200, 200)
  assert.deepEqual(computeHoverRect({ art }, container, 0.6), r(92.8, 92.8, 207.2, 207.2))
  assert.deepEqual(computeHoverRect({ art }, container, 2), r(76, 76, 224, 224))
})

test('normalizePoint：相对矩形的 0..1 比例（可越界），尺寸为 0 返回 null', () => {
  const rect = r(100, 200, 300, 600)
  assert.deepEqual(normalizePoint(200, 400, rect), { nx: 0.5, ny: 0.5 })
  assert.deepEqual(normalizePoint(100, 200, rect), { nx: 0, ny: 0 })
  assert.deepEqual(normalizePoint(300, 600, rect), { nx: 1, ny: 1 })
  assert.deepEqual(normalizePoint(50, 700, rect), { nx: -0.25, ny: 1.25 })
  assert.equal(normalizePoint(1, 1, r(10, 10, 10, 10)), null, '零尺寸')
  assert.equal(normalizePoint(1, 1, null), null)
})

test('computeHoverRect 与 containsPoint 组合：矩形边界上的点算命中（含外扩边缘）', () => {
  const container = r(0, 0, 240, 280)
  const rect = computeHoverRect({ art: r(100, 100, 200, 200) }, container, 1) // (88,88,212,212)
  assert.equal(containsPoint(rect, 88, 150), true)
  assert.equal(containsPoint(rect, 87.9, 150), false)
  assert.equal(containsPoint(rect, 150, 212), true)
  assert.equal(containsPoint(rect, 150, 212.1), false)
})
