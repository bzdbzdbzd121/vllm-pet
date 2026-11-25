import test from 'node:test'
import assert from 'node:assert/strict'
import {
  unionRect,
  padRect,
  clampRect,
  containsPoint,
  hoverPad,
  computeHoverRect,
  padRectY,
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

test('computeHoverRect：本体/阴影外扩 → 并入文字（仅纵向外扩）→ 裁剪', () => {
  const art = r(48, 17, 192, 225)
  const shadow = r(76, 223, 164, 241)
  const status = r(92, 248, 149, 272)
  const container = r(0, 0, 240, 280)
  const rect = computeHoverRect({ art, shadow, status }, container, 1)
  // 本体/阴影并集 = (48,17,192,241)；外扩 12 → (36,5,204,253)
  // 文字：**纵向**外扩 12 → (92,236,149,284)，横向不加 → 左右仍是 92/149
  // union → (36,5,204,284)；裁剪到容器 → (36,5,204,280)
  assert.deepEqual(rect, r(36, 5, 204, 280))
})

test('padRectY：只对上下外扩，左右不变（横向留白不会被文字吃掉）', () => {
  assert.deepEqual(padRectY(r(100, 200, 140, 260), 12), r(100, 188, 140, 272))
  assert.deepEqual(padRectY(r(100, 200, 140, 260), 0), r(100, 200, 140, 260))
  assert.equal(padRectY(null, 12), null)
  assert.deepEqual(padRectY(r(0, 0, 10, 10), -2), r(0, 2, 10, 8))
})

test('状态文字纵向留出可停区：文字下方 12×缩放 仍算命中（v0.3.0 同款余量）', () => {
  const container = r(0, 0, 240, 280)
  const art = r(48, 17, 192, 225)
  const status = r(86, 247, 154, 272)
  const rect = computeHoverRect({ art, status }, container, 1)
  assert.equal(rect.bottom, 280, '底边 = 文字底 272 + 12 外扩，再裁到窗口底 280')
  assert.equal(containsPoint(rect, 120, 274), true, '文字下方 2px（v0.3.0 是命中区）必须命中')
  assert.equal(containsPoint(rect, 120, 279), true, '窗口最底部仍需命中')
  // 2 档：文字底 531.8 + 24 = 555.8，不再被窗口底裁掉
  assert.equal(computeHoverRect({ art: r(96, 42, 384, 448), status: r(115.5, 507.3, 364.5, 531.8) }, r(0, 0, 480, 560), 2).bottom, 555.8)
})

test('computeHoverRect：文字只做纵向外扩，横向不扩（否则长文字会把矩形撑成整窗）', () => {
  const container = r(0, 0, 240, 280)
  const art = r(48, 19, 192, 224)
  const status = r(33.5, 231, 206.5, 272)
  const rect = computeHoverRect({ art, status }, container, 1)
  assert.equal(rect.left, 33.5, '左边界 = 文字原盒左边（横向不加 12）')
  assert.equal(rect.right, 206.5, '右边界 = 文字原盒右边（横向不加 12）')
  assert.equal(containsPoint(rect, 32, 260), false, '文字左边外 1.5px 不命中')
  assert.equal(rect.top, 7, '上边界 = 本体外扩（19-12）')
  assert.equal(rect.bottom, 280, '下边界 = 文字底 + 12 再裁剪')
})

test('computeHoverRect：长文字（近满窗宽）时矩形两侧仍留白，不退化成整窗', () => {
  const container = r(0, 0, 240, 280)
  const art = r(48, 19, 192, 224)
  // 修法后的气泡上限 = round(240*0.72) = 173 → 文字盒约 33.5..206.5
  const status = r(33.5, 231, 206.5, 272)
  const rect = computeHoverRect({ art, status }, container, 1)
  // 本体两侧外扩后是 36..204，文字盒 33.5..206.5 更宽 → 取文字盒的边，**横向不再外扩**
  assert.equal(rect.left, 33.5, '左边界取文字原盒左边缘（横向加 12 会到 21.5）')
  assert.equal(rect.right, 206.5, '右边界取文字原盒右边缘（横向加 12 会到 218.5）')
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
