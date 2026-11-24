/**
 * hover-region.js — 悬停命中矩形的纯计算（零依赖、不碰 DOM，浏览器/Node 通用）
 *
 * 命中区语义：`union( (本体 ∪ 地面阴影) 外扩 12×缩放 , 当前可见状态文字原盒 )`，
 * 再裁剪到宠物容器内。判定用闭区间。**状态文字不参与外扩**（见 computeHoverRect 注释）。
 *
 * 为什么要外扩：宠物自身的 bob/sway/shake/celebrate 会让轮廓在 ±4~7px 内移动
 *（celebrate 更高），外扩把这段位移吃掉，静止指针才不会在矩形边界上反复进出。
 *
 * 矩形一律用客户端坐标（CSS px）的 {left, top, right, bottom} 表示；
 * 任何一项取不到都允许传 null，函数会跳过它。
 */

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Rect */

/**
 * 多个矩形取并集，忽略 null/undefined；全部为空时返回 null。
 * @param {...(Rect|null|undefined)} rects
 * @returns {Rect|null}
 */
export function unionRect(...rects) {
  let out = null
  for (const r of rects) {
    if (!r) continue
    out = out
      ? {
          left: Math.min(out.left, r.left),
          top: Math.min(out.top, r.top),
          right: Math.max(out.right, r.right),
          bottom: Math.max(out.bottom, r.bottom)
        }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }
  return out
}

/**
 * 四周外扩 pad 像素（负值即内缩）。
 * @param {Rect|null} rect
 * @param {number} pad
 * @returns {Rect|null}
 */
export function padRect(rect, pad) {
  if (!rect) return null
  const p = Number.isFinite(pad) ? pad : 0
  return { left: rect.left - p, top: rect.top - p, right: rect.right + p, bottom: rect.bottom + p }
}

/**
 * 把矩形裁剪到容器内（容器兜底：无容器则原样返回）。
 * @param {Rect|null} rect
 * @param {Rect|null} container
 * @returns {Rect|null}
 */
export function clampRect(rect, container) {
  if (!rect) return null
  if (!container) return rect
  return {
    left: Math.max(container.left, rect.left),
    top: Math.max(container.top, rect.top),
    right: Math.min(container.right, rect.right),
    bottom: Math.min(container.bottom, rect.bottom)
  }
}

/**
 * 点是否在矩形内（**闭区间**，边界算命中；测试固定这一点）。
 * @param {Rect|null} rect
 * @param {number} x
 * @param {number} y
 */
export function containsPoint(rect, x, y) {
  if (!rect) return false
  return rect.left <= x && x <= rect.right && rect.top <= y && y <= rect.bottom
}

/**
 * 外扩量：12px × 缩放，缩放夹在 [0.5, 2]（覆盖 bob ±7、sway ±2.2°≈4.3、shake ±1.6）。
 * 结果保留两位小数，避免 0.6 → 7.199999… 这类的浮点噪声传到几何断言里。
 * @param {number} scale
 */
export function hoverPad(scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const pad = 12 * Math.min(2, Math.max(0.5, s))
  return Math.round(pad * 100) / 100
}

/**
 * 命中矩形：`clamp( union(pad(art ∪ shadow), status), container )`。
 *
 * 外扩只作用于「本体 + 阴影」（吃掉 bob/sway/shake 的位移），**状态文字用它自己的盒子、不再外扩**：
 * 给文字加外扩会把窗口底部的留白吃掉（1 档文字底 272 + 12 > 280 → 裁到窗底），
 * 矩形一旦贴满窗口，「从状态文字上移开」就再也恢复不了（用户实测缺陷）。
 * 全部取不到时退回容器（保证「至少有窗口范围」这一兜底语义）。
 * @param {{ art?: Rect|null, shadow?: Rect|null, status?: Rect|null }} parts
 * @param {Rect|null} container
 * @param {number} scale
 * @returns {Rect|null}
 */
export function computeHoverRect(parts, container, scale) {
  const body = unionRect(parts?.art, parts?.shadow)
  const content = unionRect(body ? padRect(body, hoverPad(scale)) : null, parts?.status)
  if (!content) return container || null
  return clampRect(content, container)
}

/**
 * 归一化到矩形内的 0..1 比例（可越界；容器尺寸为 0 或矩形缺失时返回 null）。
 * @param {number} x
 * @param {number} y
 * @param {Rect|null} rect
 * @returns {{ nx: number, ny: number }|null}
 */
export function normalizePoint(x, y, rect) {
  if (!rect) return null
  const w = rect.right - rect.left
  const h = rect.bottom - rect.top
  if (!(w > 0) || !(h > 0)) return null
  return { nx: (x - rect.left) / w, ny: (y - rect.top) / h }
}
