/**
 * hover-probe.js — 注入到渲染页执行的命中区采样脚本（普通脚本，不是 ESM 模块）
 *
 * 用法：主进程在冒烟模式下把本文件文本交给 webContents.executeJavaScript()，
 * 最后一条表达式就是 IIFE 的返回值 —— 一行结果字符串：
 *   HOVER-PROBE scale=1 pass=17 fail=0
 *   HOVER-PROBE scale=2 pass=15 fail=2
 *   (120,232) 地面阴影中心 期望命中=false 实际=true
 *
 * 坐标表就是本文件 POINTS 里的 17 点（SVG viewBox 坐标，240×280）—— 它就是实现侧的坐标真值，
 * 改坐标请只改这里，并同步 `scripts/probe-hover.mjs` 的期望（两者共用同一份表）。
 *
 * 坐标换算用 SVG 的 getScreenCTM()（viewBox 单位 → 屏幕像素），而不是直接拿
 * `.pet-stage` 的矩形按比例换算：窗口窄于 240px（桌面版缩放 < 1）时，`.pet-stage` 会被
 * `#app` 的 flex 容器压缩，SVG 随后按 preserveAspectRatio 居中留边（letterbox），
 * 此时「矩形等比换算」会把坐标对到错的位置（实测 0.6 档偏 14.4px）。
 * getScreenCTM() 已包含舞台的 CSS transform 与父级缩放（预览页 1.15 倍同理），
 * 两种写法在缩放 ≥ 1、无留边时结果完全一致。
 *
 * 报告的 `scale` 是真实渲染比例（屏幕像素 / viewBox 单位）。它可能与配置的体型缩放不等：
 * 缩放 < 1 时上述压缩会让实际比例更小（0.6 配置 → 0.36），看到这个差异说明窗口排版被挤压，
 * 属于既有布局问题（与悬停淡化无关），探针本身仍应全绿。
 *
 * 采样前先注入一次性样式冻结动画：天线光晕有脉冲（y 顶边 17.25~21），不冻结时
 * (132,36)「光晕环内、灯球外」这类贴边界的点会随帧抖动。
 *
 * 这里只验证**几何命中**（elementFromPoint + closest('.r-hover')），不验证淡化状态机：
 * 状态由指针事件锁存（pet.js 的 pointermove/pointerover + closest），与伪类无关，需另一套
 * 「指针不动、定时采样 opacity」的回归来覆盖（见 DEVELOPMENT.md 设计决策 9）。
 */
(() => {
  const BASE_W = 240
  const BASE_H = 280

  const POINTS = [
    [120, 114, true, '头壳/脸屏中心'],
    [120, 36, true, '天线灯球'],
    [120, 56, true, '天线杆'],
    [54, 116, true, '左耳'],
    [68, 195, true, '左臂'],
    [120, 200, true, '身体中心'],
    [5, 5, false, '窗口左上空白'],
    [20, 140, false, '左侧空白带'],
    [225, 140, false, '右侧空白带'],
    [120, 5, false, '头顶上方'],
    [60, 70, false, '头壳圆角外侧'],
    [81, 195, false, '臂与身体之间的缝'],
    [132, 36, false, '光晕环内、灯球外'],
    [120, 232, false, '地面阴影中心'],
    [120, 245, false, '本体下缘与气泡之间'],
    [120, 260, false, '状态文字气泡'],
    [190, 92, false, '右侧空白 + 汗滴区域']
  ]

  const stage = document.querySelector('.pet-stage')
  if (!stage) return 'HOVER-PROBE fail=1 找不到 .pet-stage，无法采样'
  if (!stage.querySelector('.r-hover')) {
    return 'HOVER-PROBE fail=1 当前皮肤缺少 .r-hover 分组，悬停命中区不存在'
  }

  // 冻结动画：光晕/呼吸动画会让贴边采样点在不同帧得到不同结果
  const freeze = document.createElement('style')
  freeze.textContent = '.pet-scale,.r-head,.r-arm,.r-antenna-glow,.r-shadow{animation:none!important}'
  document.head.append(freeze)

  const svg = stage.querySelector('svg')
  const ctm = svg && typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null

  let scale
  let toClient
  if (ctm) {
    scale = Math.round(Math.hypot(ctm.a, ctm.b) * 100) / 100
    toClient = (x, y) => [ctm.a * x + ctm.c * y + ctm.e, ctm.b * x + ctm.d * y + ctm.f]
  } else {
    // 兜底：老实现/异常环境拿不到 CTM 时按舞台矩形等比换算（缩放 ≥ 1 无留边时结果相同）
    const rect = stage.getBoundingClientRect()
    scale = Math.round((rect.width / BASE_W) * 100) / 100
    toClient = (x, y) => [rect.left + (x * rect.width) / BASE_W, rect.top + (y * rect.height) / BASE_H]
  }

  const failures = []
  for (const [x, y, expected, label] of POINTS) {
    const [cx, cy] = toClient(x, y)
    const el = document.elementFromPoint(cx, cy)
    const hit = !!el?.closest?.('.r-hover')
    if (hit === expected) continue
    const who = el ? (el.className?.baseVal ?? el.className ?? el.tagName ?? '未知元素') : '无元素'
    failures.push(`(${x},${y}) ${label} 期望命中=${expected} 实际=${hit} 命中元素=${who}`)
  }

  const pass = POINTS.length - failures.length
  if (!failures.length) return `HOVER-PROBE scale=${scale} pass=${pass} fail=0`
  return `HOVER-PROBE scale=${scale} pass=${pass} fail=${failures.length}\n${failures.join('\n')}`
})()
