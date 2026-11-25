/**
 * hover-probe.js — 注入到渲染页执行的命中区采样脚本（普通脚本，不是 ESM 模块）
 *
 * 用法：主进程在冒烟模式下把本文件文本交给 webContents.executeJavaScript()，
 * 最后一条表达式就是 IIFE 的返回值 —— 一行结果字符串：
 *   HOVER-PROBE scale=1 pass=15 fail=0
 *   HOVER-PROBE scale=2 pass=15 fail=0      ← 三档一致，通过时一律 pass=15
 *   失败时逐条列出，例如：(20,140) 左侧空白：期望矩形已伸到 x=0.0，反例失效（矩形退化成整窗？）
 * 输出格式保持不变（`scripts/probe-hover.mjs` 与 main.js 的冒烟分支不用改）。
 *
 * 语义（命中区是**矩形**，不是绘制图形）：
 * 命中区 = clamp( union( pad(本体 ∪ 地面阴影, 12×缩放), padY(当前可见状态文字, 12×缩放) ), 容器 )——
 * 状态文字**只纵向**外扩（纵向是可停区），横向不外扩（横向加 pad 会把矩形撑成整窗）。
 * 因此「矩形内的空隙」「光晕环」「阴影」「文字」都算命中；只有矩形外与设置面板除外。
 * 矩形的左右空白反例是**强制**校验（不再因文字较宽而跳过），并额外断言两侧留白 ≥6px：
 * 文字不加外扩、气泡上限 = 72% 容器宽 —— 任何一处改回去都会让矩形贴近窗口边缘，这里必须失败。
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

  // 4) 左右空白：**强制校验**（此前「文字较宽时跳过」掩盖了矩形退化成整窗的缺陷）。
  //    期望矩形按现行口径复算：pad(本体 ∪ 阴影) ∪ 文字原盒（文字不加外扩）。
  const body = box(artBox, shadowBox)
  const expected = box(
    body ? { left: body.left - pad, top: body.top - pad, right: body.right + pad, bottom: body.bottom + pad } : null,
    // 状态文字：只纵向扩 pad（横向不外扩，否则长文字会把矩形撑成整窗）
    statusBox ? { left: statusBox.left, top: statusBox.top - pad, right: statusBox.right, bottom: statusBox.bottom + pad } : null
  )
  const reach = expected
    ? { left: Math.max(c.left, expected.left) - c.left, right: Math.min(c.right, expected.right) - c.left }
    : null
  if (reach) {
    if (20 * scale < reach.left - 1) expect(asContainer(20, 140), false, '(容器 20,140) 左侧空白')
    else failures.push(`(容器 20,140) 左侧空白：期望矩形已伸到 x=${reach.left.toFixed(1)}，反例失效（矩形退化成整窗？）`)
    if (225 * scale > reach.right + 1) expect(asContainer(225, 140), false, '(容器 225,140) 右侧空白')
    else failures.push(`(容器 225,140) 右侧空白：期望矩形已伸到 x=${reach.right.toFixed(1)}，反例失效（矩形退化成整窗？）`)
  }

  // 5) 硬断言：状态文字可见时，命中矩形两侧与容器的间距都必须 ≥ 6px
  //    （防止「气泡太宽 + 文字外扩」再次把矩形打满窗口；0.6 档因文字贴窗底只查左右）
  if (statusBox) {
    const gapL = (expected ? expected.left : c.left) - c.left
    const gapR = c.right - (expected ? expected.right : c.right)
    const label = `矩形侧向留白 ≥6px（左 ${gapL.toFixed(1)} / 右 ${gapR.toFixed(1)}）`
    if (gapL >= 6 && gapR >= 6) pass++
    else failures.push(`${label} 期望左右都 ≥6px —— 留白不足说明气泡上限或文字外扩又改回去了`)
  }

  const head = `HOVER-PROBE scale=${scale} pass=${pass} fail=${failures.length}`
  if (!failures.length) return head
  return `${head}\n${failures.join('\n')}`
})()
