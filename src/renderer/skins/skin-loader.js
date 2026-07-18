/**
 * skin-loader.js — 皮肤加载与解析
 *
 * 皮肤定义（skin.json）固定顶层字段：
 *   { name, displayName, version, palette: {...}, animations: {...} }
 * 可选自定义资源（通过 IPC loadSkin 返回的 assets，dataUrl 形式）：
 *   robot.svg — 完整替换机器人 SVG 结构（需保留 class 钩子才能复用内置动画，见 skins/README.md）
 */
import defaultSkinJson from './default-robot/skin.json'
import defaultRobotSvg from './default-robot/robot.svg?raw'

export const BUILTIN_SKIN = Object.freeze({
  ...defaultSkinJson,
  builtin: true,
  robotSvg: defaultRobotSvg
})

/** 应用皮肤到舞台元素：调色板 → CSS 变量，动画节奏 → 状态时长表 */
export function applySkinToStage(stageEl, skin) {
  const palette = skin.palette || {}
  const varMap = {
    body: '--c-body',
    bodyShade: '--c-body-shade',
    face: '--c-face',
    eye: '--c-eye',
    accent: '--c-accent',
    glow: '--c-glow'
  }
  for (const [key, cssVar] of Object.entries(varMap)) {
    if (palette[key]) stageEl.style.setProperty(cssVar, palette[key])
  }
  if (skin.animations?.blinkMs) {
    stageEl.style.setProperty('--blink-dur', `${skin.animations.blinkMs}ms`)
  }
}

/** 皮肤在某视觉状态下的 bob 时长（毫秒） */
export function bobDurationFor(skin, visualState) {
  return skin.animations?.bobMs?.[visualState] ?? 3200
}

function decodeDataUrl(dataUrl) {
  try {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    return decodeURIComponent(escape(atob(base64)))
  } catch {
    return null
  }
}

/**
 * 解析皮肤：内置皮肤直接可用；命名皮肤经 IPC 从 <userData>/skins/<name>/ 读取。
 * 任何失败都回退到内置皮肤，保证桌宠一定能渲染。
 */
export async function resolveSkin(skinName, bridge) {
  if (!skinName || skinName === BUILTIN_SKIN.name || !bridge?.loadSkin) {
    return { ...BUILTIN_SKIN }
  }
  try {
    const raw = await bridge.loadSkin(skinName)
    if (!raw || raw.name !== skinName) return { ...BUILTIN_SKIN }
    const skin = {
      name: raw.name,
      displayName: raw.displayName || raw.name,
      version: raw.version ?? 1,
      builtin: false,
      palette: { ...BUILTIN_SKIN.palette, ...(raw.palette || {}) },
      animations: {
        bobMs: { ...BUILTIN_SKIN.animations.bobMs, ...(raw.animations?.bobMs || {}) },
        blinkMs: raw.animations?.blinkMs ?? BUILTIN_SKIN.animations.blinkMs
      },
      robotSvg: defaultRobotSvg
    }
    const customSvg = raw.assets?.['robot.svg']
    if (typeof customSvg === 'string' && customSvg.startsWith('data:')) {
      const decoded = decodeDataUrl(customSvg)
      if (decoded && decoded.includes('<svg')) skin.robotSvg = decoded
    }
    return skin
  } catch {
    return { ...BUILTIN_SKIN }
  }
}

/** 列出可选皮肤（内置 + 用户目录），无 IPC 时只有内置 */
export async function listAvailableSkins(bridge) {
  const builtinEntry = { name: BUILTIN_SKIN.name, displayName: BUILTIN_SKIN.displayName, builtin: true }
  if (!bridge?.listSkins) return [builtinEntry]
  try {
    const list = await bridge.listSkins()
    const rest = (Array.isArray(list) ? list : []).filter((s) => s.name !== BUILTIN_SKIN.name)
    return [builtinEntry, ...rest]
  } catch {
    return [builtinEntry]
  }
}
