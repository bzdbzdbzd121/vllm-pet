/**
 * hover-fade.js — 悬停淡化配置的语义与归一化（纯函数，零依赖，浏览器/Node 通用）
 *
 * 数据形状（config.json 顶层，与 showStatus 同级）：
 *
 *   "hoverFade": { "enabled": true, "opacity": 0.4 }
 *
 * 两条语义边界，避免「配置缺失/写错 → 行为意外变化」：
 *   1. 任何畸形输入都回到默认（开启 + 40%），不抛错、不返回部分结果。
 *   2. opacity 允许 0（悬停时完全透明），所以数值解析**不能**用 `Number(raw)`
 *      一把梭：`Number(null) === 0` 会把「没设置」静默变成「全透明」。
 */

/** 默认值：开启，悬停时 40% 不透明度 */
export const DEFAULT_HOVER_FADE = Object.freeze({ enabled: true, opacity: 0.4 })

/**
 * 归一化悬停淡化配置：任何畸形输入都回到默认；数值夹到 [0, 1]；不修改入参。
 * @param {unknown} input config.hoverFade（可能缺失或形状不对）
 * @returns {{ enabled: boolean, opacity: number }} 始终是完整、可直接使用的新对象
 */
export function normalizeHoverFade(input) {
  const raw = input && typeof input === 'object' ? input : {}

  // 只有真布尔才采信；'false' / 0 / null 一律回默认（默认开启），
  // 避免手工改配置时「看起来关了其实没关」。
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_HOVER_FADE.enabled

  let n = NaN
  if (typeof raw.opacity === 'number') n = raw.opacity
  else if (typeof raw.opacity === 'string' && raw.opacity.trim() !== '') n = Number(raw.opacity)
  // 数字与非空数字字符串才参与；NaN / Infinity / null / '' / 空白串都落到默认值
  const opacity = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_HOVER_FADE.opacity

  return { enabled, opacity }
}
