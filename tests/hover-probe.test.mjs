import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { SCALES, parseProbeReport, summarize } from '../scripts/probe-hover.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = fs.readFileSync(path.join(ROOT, 'scripts/hover-probe.js'), 'utf8')

/* ------------------------------------------------------------------
 * 用独立的几何模型（按 default-robot/robot.svg 的 x/y/width/height/rx
 * 与本项目 robot.css 的 pointer-events 事实建模）充当浏览器：
 * 探针里的坐标表若被改动/写错，这里会给出与该模型不一致的结果 → 测试变红。
 * ------------------------------------------------------------------ */

const inRect = (px, py, x, y, w, h, r = 0) => {
  if (px < x || px > x + w || py < y || py > y + h) return false
  if (r <= 0) return true
  // 圆角矩形：把点夹到「能放圆心的内矩形」，再比距离
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  return Math.hypot(px - cx, py - cy) <= r
}
const inCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) <= r

/** .r-hover 分组里真正可命中的绘制图形（描边按 +1.5 外扩） */
const HIT_SHAPES = [
  ['antenna-stem', (x, y) => inRect(x, y, 117.5, 46, 5, 20)],
  ['antenna-bulb', (x, y) => inCircle(x, y, 120, 36, 8)],
  ['ear-left', (x, y) => inRect(x, y, 48, 104, 12, 24, 6)],
  ['ear-right', (x, y) => inRect(x, y, 180, 104, 12, 24, 6)],
  ['head-shell', (x, y) => inRect(x, y, 56.5, 62.5, 127, 103, 31.5)],
  ['arm-left', (x, y) => inRect(x, y, 58, 176, 20, 38, 10)],
  ['arm-right', (x, y) => inRect(x, y, 162, 176, 20, 38, 10)],
  ['body-shell', (x, y) => inRect(x, y, 82.5, 166.5, 75, 59, 21.5)]
]

/** 不参与命中的元素（robot.css 里 pointer-events: none） */
const TRANSPARENT_SHAPES = {
  glow: (x, y) => inCircle(x, y, 120, 36, 15),
  shadow: (x, y) => inCircle(x, y, 120, 232, 44) && Math.abs(y - 232) <= 9 * Math.sqrt(1 - Math.min(1, ((x - 120) / 44) ** 2)),
  statusBubble: (x, y) => y >= 250,
  sweat: (x, y) => inCircle(x, y, 190, 92, 6)
}

function makeFakePage({ scale = 1, left = 0, top = 0, letterbox = 0, hitRegion = true, extraHitShapes = [], withCtm = true } = {}) {
  const rect = { left, top, width: 240 * scale, height: 280 * scale }
  const shapes = [...HIT_SHAPES, ...extraHitShapes]
  const frozen = []
  const svg = withCtm
    ? {
        // SVG 的 viewBox → 屏幕像素矩阵：缩放 + 留边偏移（letterbox 模拟窗口窄于 240px）
        getScreenCTM: () => ({ a: scale, b: 0, c: 0, d: scale, e: rect.left, f: rect.top + letterbox })
      }
    : null
  const stage = {
    getBoundingClientRect: () => ({ ...rect }),
    querySelector: (sel) => {
      if (sel === '.r-hover') return hitRegion ? { classList: ['r-hover'] } : null
      if (sel === 'svg') return svg
      return null
    }
  }
  const document = {
    querySelector: (sel) => (sel === '.pet-stage' ? stage : null),
    createElement: () => ({ textContent: '' }),
    head: { append: (el) => frozen.push(el.textContent) },
    elementFromPoint: (cx, cy) => {
      // 客户端坐标换算回 viewBox 坐标（探针必须做对这一步，缩放/留边才不影响结果）
      const lx = ((cx - rect.left) / scale)
      const ly = ((cy - rect.top - (svg ? letterbox : 0)) / (svg ? scale : rect.height / 280))
      const hit = shapes.some(([, fn]) => fn(lx, ly))
      return { closest: (sel) => (sel === '.r-hover' && hit ? { tag: 'g' } : null) }
    }
  }
  return { document, frozen, rect }
}

const runProbe = (opts) => {
  const { document, frozen } = makeFakePage(opts)
  const out = vm.runInNewContext(PROBE, { document })
  return { out, frozen }
}

/* ---------------- 探针本身 ---------------- */

test('探针：三档缩放、任意舞台偏移都是 17/17 通过（viewBox → 屏幕坐标映射正确）', () => {
  for (const scale of SCALES) {
    for (const [left, top] of [[0, 0], [13, 27]]) {
      const { out } = runProbe({ scale, left, top })
      assert.match(out, /^HOVER-PROBE scale=[\d.]+ pass=17 fail=0$/, `scale=${scale} left=${left} top=${top} → ${out}`)
      assert.ok(out.includes(`scale=${scale}`), `探针应报出缩放倍率：${out}`)
    }
  }
})

test('探针：窗口窄于 240px 导致 SVG 居中留边时仍然全通过（不能用矩形等比换算）', () => {
  // 桌面版缩放 0.6：舞台被 flex 压缩到 144px 宽 → SVG 实际渲染 86.4×100.8，垂直留边 33.6px
  const scale0 = 0.36
  const letterbox = 33.6
  const { out } = runProbe({ scale: scale0, letterbox })
  assert.match(out, /pass=17 fail=0/, `letterbox 场景应全通过，实际：${out}`)
  assert.match(out, /scale=0\.36/, '应报出真实渲染比例')
})

test('探针：拿不到 getScreenCTM 时回退到舞台矩形换算（缩放 ≥ 1 无留边时等价）', () => {
  for (const scale of [1, 2]) {
    const { out } = runProbe({ scale, withCtm: false })
    assert.match(out, /pass=17 fail=0/, `回退路径应同样全通过（scale=${scale}）：${out}`)
  }
})

test('探针：先冻结动画（第 13 点光晕在脉冲动画下会飘）', () => {
  const { frozen } = runProbe({})
  assert.equal(frozen.length, 1, '应注入一次性冻结样式')
  assert.match(frozen[0], /\.r-antenna-glow/, '冻结样式必须覆盖天线光晕')
  assert.match(frozen[0], /animation:\s*none\s*!important/)
})

test('探针：地面阴影变成可命中时立刻报红，并给出坐标与期望值', () => {
  const { out } = runProbe({
    // 把阴影悄悄塞进命中图形（模拟「皮肤在 .r-hover 里放了可见阴影/大块图形」的回归）
    extraHitShapes: [['shadow', (x, y) => TRANSPARENT_SHAPES.shadow(x, y)]]
  })
  assert.match(out, /fail=1/)
  assert.match(out, /\(120,232\)/, '失败信息必须指出具体坐标')
  assert.match(out, /期望命中=false/, '失败信息必须给出期望值')
  assert.match(out, /地面阴影/, '失败信息必须给出该点名称')
})

test('探针：命中点缺失（例如手臂画错位置）也能指出坐标', () => {
  // 把左臂整体右移 20px：左臂点 (68,195) 落空，臂身缝 (81,195) 被误盖 → 两处都应报出来
  const shifted = [['arm-left-shifted', (x, y) => inRect(x, y, 78, 176, 20, 38, 10)]]
  const out = vm.runInNewContext(PROBE, {
    document: {
      querySelector: (sel) =>
        sel === '.pet-stage'
          ? {
              getBoundingClientRect: () => ({ left: 0, top: 0, width: 240, height: 280 }),
              querySelector: (s) => (s === 'svg' ? { getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) } : {})
            }
          : null,
      createElement: () => ({ textContent: '' }),
      head: { append: () => {} },
      elementFromPoint: (cx, cy) => {
        const shapes = [...HIT_SHAPES.filter(([n]) => n !== 'arm-left'), ...shifted]
        const hit = shapes.some(([, fn]) => fn(cx, cy))
        return { closest: (sel) => (sel === '.r-hover' && hit ? { tag: 'g' } : null) }
      }
    }
  })
  assert.match(out, /fail=2/)
  assert.match(out, /\(68,195\).*期望命中=true/, '缺失的命中点必须指出坐标与期望值')
  assert.match(out, /\(81,195\).*期望命中=false/, '被误盖的缝隙也必须指出')
})

test('探针：皮肤缺 .r-hover / 页面没有 .pet-stage 时给出可读结论而不是抛错', () => {
  assert.match(runProbe({ hitRegion: false }).out, /HOVER-PROBE fail.*\.r-hover/s)
  const out = vm.runInNewContext(PROBE, { document: { querySelector: () => null } })
  assert.match(out, /HOVER-PROBE fail.*\.pet-stage/s)
})

/* ---------------- 运行器 ---------------- */

test('运行器：缩放档位是 0.6 / 1 / 2', () => {
  assert.deepEqual(SCALES, [0.6, 1, 2])
})

test('运行器：能从混着日志的输出里解析结果，缺结果时返回 null', () => {
  const stdout = [
    '[smoke] userData = /tmp/x',
    '[hover-probe] HOVER-PROBE scale=0.6 pass=17 fail=0',
    'some trailing log'
  ].join('\n')
  assert.deepEqual(parseProbeReport(stdout), { scale: 0.6, pass: 17, fail: 0 })

  const failed = 'HOVER-PROBE scale=2 pass=15 fail=2\n(120,232) 地面阴影中心 期望命中=false 实际=true'
  assert.deepEqual(parseProbeReport(failed), { scale: 2, pass: 15, fail: 2 })

  assert.equal(parseProbeReport('[smoke] 截图已保存: /tmp/a.png'), null)
  assert.equal(parseProbeReport(''), null)
})

test('运行器：汇总三档，任一档失败即整体失败并指出是哪一档', () => {
  const ok = summarize([
    { scale: 0.6, pass: 17, fail: 0 },
    { scale: 1, pass: 17, fail: 0 },
    { scale: 2, pass: 17, fail: 0 }
  ])
  assert.equal(ok.ok, true)
  assert.match(ok.text, /0\.6/)
  assert.match(ok.text, /通过/)

  const bad = summarize([
    { scale: 0.6, pass: 17, fail: 0 },
    { scale: 1, pass: 16, fail: 1 },
    { scale: 2, pass: 17, fail: 0 }
  ])
  assert.equal(bad.ok, false)
  assert.match(bad.text, /scale=1/)
})
