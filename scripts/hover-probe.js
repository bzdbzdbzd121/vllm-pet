/**
 * hover-probe.js — 注入到渲染页执行的命中区采样脚本（普通脚本，不是 ESM 模块）
 *
 * 用法：主进程在冒烟模式下把本文件文本交给 webContents.executeJavaScript()，
 * 最后一条表达式就是 IIFE 的返回值 —— 一行结果字符串：
 *   HOVER-PROBE scale=1 pass=15 fail=0
 *   HOVER-PROBE scale=2 pass=14 fail=1
 *   (20,140) 左侧空白 期望命中=false 实际=true
 * 输出格式保持不变（`scripts/probe-hover.mjs` 与 main.js 的冒烟分支不用改）。
 *
 * 语义（命中区是**矩形**，不是绘制图形）：
 * 命中区 = union(本体, 地面阴影, 当前可见状态文字) 外扩 12×缩放，再裁剪到容器。
 * 因此「矩形内的空隙」「光晕环」「阴影」「文字」都算命中；只有矩形外与设置面板除外。
 *
 * 判定方式是**端到端**的：对每个测试点，向容器派发一次合成 pointermove（带 clientX/clientY），
 * 然后读舞台是否带 `.is-hovering` —— 测的是线上真实逻辑（矩形 + 设置面板排除），
 * 探针自己不算几何。
 *
 * 采样前先注入一次性样式冻结动画：矩形取的是当前帧的包围盒，冻结后结果才稳定。
 *
 * 坐标：本体上的采样点用 SVG viewBox 坐标（经 getScreenCTM 换算成客户端坐标，缩放/留边都正确）；
 * 「容器外」与「左右空白」用容器左上角起算的 CSS px × 缩放；阴影与文字点取各自 DOM 框的中心。
 */
(() => {
  const BASE_W = 240
  const PAD = 12

  const stage = document.querySelector('.pet-stage')
  if (!stage) return 'HOVER-PROBE fail=1 找不到 .pet-stage，无法采样'
  const container = stage.parentElement || stage

  // 冻结动画：矩形取当前帧包围盒，不冻结会让采样点在不同相位得到不同结果
  const freeze = document.createElement('style')
  freeze.textContent = '.pet-scale,.r-head,.r-arm,.r-antenna-glow,.r-shadow{animation:none!important}'
  document.head.append(freeze)

  const rectOf = (sel) => {
    const el = stage.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 || r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
  }
  const c = container.getBoundingClientRect()
  const scale = Math.round((c.width / BASE_W) * 100) / 100 || 1
  const pad = PAD * scale

  const box = (...rects) => {
    let out = null
    for (const r of rects) {
      if (!r) continue
      out = out
        ? { left: Math.min(out.left, r.left), top: Math.min(out.top, r.top), right: Math.max(out.right, r.right), bottom: Math.max(out.bottom, r.bottom) }
        : { ...r }
    }
    return out
  }
  const statusEl = stage.querySelector('.pet-status')
  const statusShown = stage.classList.contains('show-status') && Boolean(statusEl?.textContent)
  const artBox = box(rectOf('.r-hover'), null) || box((() => {
    const r = stage.querySelector('.pet-scale')?.getBoundingClientRect()
    return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
  })())
  const shadowBox = rectOf('.pet-shadow .r-shadow')
  const statusBox = statusShown && statusEl ? (() => {
    const r = statusEl.getBoundingClientRect()
    return r.width > 0 || r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null
  })() : null
  const content = box(artBox, shadowBox, statusBox)

  /** 事件坐标：容器左上角 + 局部坐标 */
  // 本体上的点用 SVG viewBox 坐标 → 客户端坐标（getScreenCTM 已含缩放与 0.6 档的留边）
  const svg = stage.querySelector('svg')
  const ctm = svg && typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null
  const toClient = (x, y) =>
    ctm
      ? { clientX: ctm.a * x + ctm.c * y + ctm.e, clientY: ctm.b * x + ctm.d * y + ctm.f }
      : { clientX: c.left + x * scale, clientY: c.top + y * scale }
  const asContainer = (x, y) => ({ clientX: c.left + x * scale, clientY: c.top + y * scale })
  const center = (box) => ({ clientX: (box.left + box.right) / 2, clientY: (box.top + box.bottom) / 2 })

  const fireAt = (pt, target = container) => {
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, ...pt, pointerType: 'mouse' }))
    return stage.classList.contains('is-hovering')
  }

  const failures = []
  let pass = 0
  const expect = (pt, expected, label, target) => {
    const got = fireAt(pt, target)
    if (got === expected) { pass++; return }
    const tag = label
    failures.push(`${tag} 期望命中=${expected} 实际=${got}`)
  }
  const inViewBox = (x, y) => ({ label: `(${x},${y})`, pt: toClient(x, y) })
  const inContainer = (x, y) => ({ label: `(容器 ${x},${y})`, pt: asContainer(x, y) })

  // 先用一次远端哑事件把矩形算出来（此时动画已冻结），之后各点复用同一矩形
  fireAt(asContainer(-50, -50))

  // 1) 矩形内必命中（与状态文字宽度无关）
  for (const [x, y, label] of [
    [120, 114, '头壳/脸屏中心'],
    [120, 36, '天线灯球'],
    [54, 116, '左耳'],
    [120, 200, '身体中心'],
    [81, 195, '臂身之间的空隙（矩形语义）'],
    [120, 166, '头身缝隙（矩形语义）'],
    [132, 36, '光晕环（矩形语义）']
  ]) {
    const p = inViewBox(x, y)
    expect(p.pt, true, `${p.label} ${label}`)
  }
  if (shadowBox) expect(center(shadowBox), true, '地面阴影中心（并集包含）')
  if (statusBox) expect(center(statusBox), true, '状态文字中心')

  // 2) 容器外必不命中（矩形被裁剪到容器，与文字宽度无关）
  for (const [x, y, label] of [[-10, 140, '容器左侧外'], [BASE_W + 10, 140, '容器右侧外'], [120, -10, '容器上方外']]) {
    const p = inContainer(x, y)
    expect(p.pt, false, `${p.label} ${label}`)
  }

  // 3) 内嵌设置面板必不命中（显式排除）
  const panel = document.querySelector('.pet-settings')
  if (panel) expect(center(panel.getBoundingClientRect()), false, '内嵌设置面板中心', panel)

  // 4) 左右空白：只有在状态文字较窄、外扩后的矩形确实够不到这两个点时才是有效反例
  const reach = content
    ? { left: Math.max(c.left, content.left - pad) - c.left, right: Math.min(c.right, content.right + pad) - c.left }
    : null
  const leftBlankOk = !reach || 20 * scale < reach.left - 1
  const rightBlankOk = !reach || 225 * scale > reach.right + 1
  if (leftBlankOk) expect(asContainer(20, 140), false, '(容器 20,140) 左侧空白')
  else pass++ // 文字很宽时矩形本身伸到这里，跳过硬断言（标签见下方说明）
  if (rightBlankOk) expect(asContainer(225, 140), false, '(容器 225,140) 右侧空白')
  else pass++
  const skips = []
  if (!leftBlankOk) skips.push('左侧空白(20,140)')
  if (!rightBlankOk) skips.push('右侧空白(225,140)')

  const total = pass + failures.length
  const head = `HOVER-PROBE scale=${scale} pass=${pass} fail=${failures.length}`
  const skipNote = skips.length ? `\n  (跳过 ${skips.join('、')}：当前状态文字较宽，矩形外扩后已覆盖该处)` : ''
  if (!failures.length) return head + skipNote
  return `${head}${skipNote}\n${failures.join('\n')}`
})()
