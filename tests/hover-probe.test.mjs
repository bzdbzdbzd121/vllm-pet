import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { SCALES, parseProbeReport, summarize } from '../scripts/probe-hover.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROBE = fs.readFileSync(path.join(ROOT, 'scripts/hover-probe.js'), 'utf8')

/**
 * 探针是注入页面的普通脚本：这里给它一个「假的页面 + 假的 PetView」——
 * 假 PetView 按矩形语义实现（union→外扩→裁剪→闭区间判定 + 设置面板排除），
 * 探针只通过「派发 pointermove → 读 .is-hovering」与它交互，因此测的是探针的
 * 点表/期望值/输出格式，而不是探针自己算的几何。
 */
/** 真的 DOMRect 有 width/height，假 DOM 也必须提供（探针用它们判空） */
function withSize(r) {
  return { ...r, width: r.right - r.left, height: r.bottom - r.top }
}

function makeEnv({ scale = 1, statusShown = true, panel = null, app = {}, statusBox: sb = null } = {}) {
  const containerRect = withSize({ left: 40, top: 30, right: 40 + 240 * scale, bottom: 30 + 280 * scale })
  const s = (v) => v * scale
  const box = (l, t, r, b) => withSize({ left: containerRect.left + s(l), top: containerRect.top + s(t), right: containerRect.left + s(r), bottom: containerRect.top + s(b) })
  const art = box(48, 17, 192, 225)
  const shadow = box(76, 223, 164, 241)
  // 默认窄文字（本体外扩盒更宽）；传 statusBox 可换成「文字更宽」的真实长文字几何
  const status = sb ? box(sb[0], sb[1], sb[2], sb[3]) : box(92, 248, 149, 272)
  const pad = (app.noPad ? 0 : 12 * scale)

  const classSet = new Set(statusShown ? ['pet-stage', 'show-status', 'hover-fade-enabled'] : ['pet-stage', 'hover-fade-enabled'])
  const stage = {
    classList: {
      contains: (c) => classSet.has(c),
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      toggle: (c, on) => (on ? classSet.add(c) : classSet.delete(c))
    },
    querySelector: (sel) => {
      if (sel === 'svg') return { getScreenCTM: () => ({ a: scale, b: 0, c: 0, d: scale, e: containerRect.left, f: containerRect.top }) }
      if (sel === '.r-hover') return app.missingArt ? null : { getBoundingClientRect: () => ({ ...art }) }
      if (sel === '.pet-scale') return { getBoundingClientRect: () => ({ ...box(0, 0, 240, 280) }) }
      if (sel === '.pet-shadow .r-shadow') return { getBoundingClientRect: () => ({ ...shadow }) }
      if (sel === '.pet-status') return { textContent: '空闲中', getBoundingClientRect: () => ({ ...status }) }
      return null
    },
    parentElement: null
  }
  const union = (...rs) => {
    let out = null
    for (const r of rs) {
      if (!r) continue
      out = out
        ? { left: Math.min(out.left, r.left), top: Math.min(out.top, r.top), right: Math.max(out.right, r.right), bottom: Math.max(out.bottom, r.bottom) }
        : { ...r }
    }
    return out
  }
  const hovering = { value: false }
  const applyApp = (clientX, clientY, target) => {
    let rect
    if (app.useStageRect) rect = { ...containerRect }
    else {
      // 现行口径：本体/阴影四周外扩 pad；状态文字**只纵向**外扩 pad（横向不外扩）
      const body = union(art, shadow)
      const paddedBody = body ? { left: body.left - pad, top: body.top - pad, right: body.right + pad, bottom: body.bottom + pad } : null
      const shown = classSet.has('show-status') && !app.hideStatusForApp
      const paddedStatus = shown
        ? app.noStatusPadY
          ? { ...status }
          : app.padStatusX
            ? { left: status.left - pad, top: status.top - pad, right: status.right + pad, bottom: status.bottom + pad }
            : { left: status.left, top: status.top - pad, right: status.right, bottom: status.bottom + pad }
        : null
      const content = union(paddedBody, paddedStatus)
      rect = content
        ? {
            left: Math.max(containerRect.left, content.left),
            top: Math.max(containerRect.top, content.top),
            right: Math.min(containerRect.right, content.right),
            bottom: Math.min(containerRect.bottom, content.bottom)
          }
        : { ...containerRect }
    }
    const onPanel = !app.ignorePanel && Boolean(target?.closest?.('.pet-settings'))
    hovering.value = !onPanel && rect.left <= clientX && clientX <= rect.right && rect.top <= clientY && clientY <= rect.bottom
    if (hovering.value) classSet.add('is-hovering')
    else classSet.delete('is-hovering')
  }

  const container = {
    getBoundingClientRect: () => ({ ...containerRect }),
    // 真 DOM 会自动给 event.target 赋值，假 DOM 在这里补上
    dispatchEvent(ev) { ev.target = ev.target || this; applyApp(ev.clientX, ev.clientY, ev.target); return true },
    closest: () => null,
    parentElement: null,
    append: () => {}
  }
  stage.parentElement = container

  const panelEl = panel
    ? {
        getBoundingClientRect: () => withSize({ left: containerRect.left + s(6), top: containerRect.top + s(4), right: containerRect.left + s(234), bottom: containerRect.top + s(200) }),
        dispatchEvent(ev) { ev.target = ev.target || this; applyApp(ev.clientX, ev.clientY, ev.target); return true },
        closest: (sel) => (sel === '.pet-settings' ? panelEl : null)
      }
    : null

  const document = {
    querySelector: (sel) => (sel === '.pet-stage' ? stage : sel === '.pet-settings' ? panelEl : null),
    createElement: () => ({ textContent: '' }),
    head: { append: () => {} }
  }
  class PointerEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init) }
  }
  return { sandbox: { document, PointerEvent }, container, stage, classSet }
}

const runProbe = (opts) => {
  const env = makeEnv(opts)
  return { out: vm.runInNewContext(PROBE, env.sandbox), ...env }
}

test('探针：矩形语义下全部点通过（缩放 0.6 / 1 / 2，含容器偏移）', () => {
  for (const scale of SCALES) {
    const { out } = runProbe({ scale })
    assert.match(out, /^HOVER-PROBE scale=[\d.]+ pass=\d+ fail=0/, `scale=${scale} → ${out}`)
    const report = parseProbeReport(out)
    assert.equal(report.fail, 0)
    assert.ok(report.pass >= 13, `scale=${scale} 通过点数偏少：${report.pass}`)
  }
})

test('探针：矩形内的空隙/光晕/阴影/文字都算命中（与 v0.2.0 的形状语义不同）', () => {
  const { out } = runProbe({})
  assert.doesNotMatch(out, /臂身之间|头身缝隙|光晕环|地面阴影|状态文字.*期望命中=true 实际=false/)
  assert.match(out, /fail=0/)
})

test('探针：容器外与设置面板中心不命中（面板存在时）', () => {
  const withPanel = runProbe({ panel: true })
  assert.match(withPanel.out, /fail=0/)
  const mutated = runProbe({ panel: true, app: { ignorePanel: true } })
  assert.match(mutated.out, /fail=1/)
  assert.match(mutated.out, /内嵌设置面板中心 期望命中=false 实际=true/)
})

test('探针：容器外坐标始终不命中（矩形的裁剪语义）', () => {
  for (const app of [{}, { useStageRect: false }]) {
    const { out } = runProbe({ app })
    assert.doesNotMatch(out, /容器[左右上下]侧?外.*期望命中=false 实际=true/)
  }
})

test('探针：退回「用整个容器当命中区」的回归会被抓住', () => {
  const { out } = runProbe({ app: { useStageRect: true } })
  assert.match(out, /fail=[1-9]/)
  assert.match(out, /(左侧空白|右侧空白|容器)/)
})

test('探针：状态文字隐藏时不再断言文字行命中（该场景由状态机测试覆盖）', () => {
  const { out } = runProbe({ statusShown: false })
  assert.match(out, /fail=0/, out)
})

test('探针：状态文字把矩形撑到覆盖左右空白时必须报 fail（不再跳过 —— 这正是上一轮的漏网条件）', () => {
  const env = makeEnv({})
  // 把状态框撑到接近整窗（旧上限 cw-10 的效果）：矩形覆盖 (20,140) / (225,140)
  const wide = env.stage.querySelector
  env.stage.querySelector = (sel) => {
    if (sel !== '.pet-status') return wide(sel)
    return { textContent: '推理中 ×3 · KV cache 87% · 12.3 tok/s · qwen2.5-72b-instruct', getBoundingClientRect: () => withSize({ left: 5, top: 231, right: 235, bottom: 272 }) }
  }
  const out = vm.runInNewContext(PROBE, env.sandbox)
  assert.doesNotMatch(out, /fail=0/, `宽文字必须失败：${out}`)
  assert.match(out, /左侧空白/, `必须报左侧空白反例失效：${out}`)
  assert.match(out, /侧向留白 ≥6px/, `必须报侧向留白不足：${out}`)
  assert.doesNotMatch(out, /跳过/, '不得再有「跳过」这条出口')
})

test('探针：纵向可停区钉子 —— 去掉状态文字纵向 pad（v0.3.1 回归）必须变红', () => {
  const okRun = runProbe({})
  assert.match(okRun.out, /fail=0/, okRun.out)
  const mutated = runProbe({ app: { noStatusPadY: true } })
  assert.match(mutated.out, /fail=[1-9]/, mutated.out)
  assert.match(mutated.out, /状态文字下方 \d+(\.\d+)?px（纵向可停区） 期望命中=true 实际=false/, mutated.out)
})

test('探针：横向钉子 —— 给状态文字横向加 pad（v0.3.0 回归）必须变红', () => {
  // 长文字几何（33.5..206.5，与线上长文字一致）：此时文字盒才是矩形的左右决定边，
  // 才能测「文字缘外 4px」。窄文字下本体外扩盒更宽，横向 pad 变化本就不可见。
  const longText = [33.5, 231, 206.5, 272]
  const narrow = parseProbeReport(vm.runInNewContext(PROBE, makeEnv({}).sandbox))
  const ok = parseProbeReport(vm.runInNewContext(PROBE, makeEnv({ statusBox: longText }).sandbox))
  assert.equal(ok.fail, 0, JSON.stringify(ok))
  // 长文字时文字是左右决定边 → 会多跑「内 1px 命中 / 外 4px 不命中」两对（+4 点）
  assert.equal(ok.pass, narrow.pass + 4, `长文字应比窄文字多 4 个横向缘点：${narrow.pass} → ${ok.pass}`)
  const mutated = vm.runInNewContext(PROBE, makeEnv({ statusBox: longText, app: { padStatusX: true } }).sandbox)
  assert.match(mutated, /fail=[1-9]/, mutated)
  assert.match(mutated, /状态文字左缘外 4px（横向加 pad 会误命中） 期望命中=false 实际=true/, mutated)
})

test('探针：期望矩形本身被改松也要变红（期望值不是自证）', () => {
  const longText = [33.5, 231, 206.5, 272]
  // 横向：把探针里的期望矩形给文字横向加 pad
  const xMut = PROBE.replace('statusBox ? { left: statusBox.left, top: statusBox.top - pad', 'statusBox ? { left: statusBox.left - pad, top: statusBox.top - pad')
  assert.notEqual(xMut, PROBE, '横向变异补丁必须生效')
  const xOut = vm.runInNewContext(xMut, makeEnv({ statusBox: longText }).sandbox)
  assert.match(xOut, /fail=[1-9]/, xOut)
  assert.match(xOut, /期望矩形横向边界/, xOut)
  // 纵向：把探针里的期望矩形去掉文字纵向 pad
  const yMut = PROBE.replace('top: statusBox.top - pad, right: statusBox.right, bottom: statusBox.bottom + pad', 'top: statusBox.top, right: statusBox.right, bottom: statusBox.bottom')
  assert.notEqual(yMut, PROBE, '纵向变异补丁必须生效')
  const yOut = vm.runInNewContext(yMut, makeEnv({ statusBox: longText }).sandbox)
  assert.match(yOut, /fail=[1-9]/, yOut)
  assert.match(yOut, /期望矩形下边界/, yOut)
})

test('探针：输出契约不变（供 probe-hover.mjs 与冒烟分支解析）', () => {
  const { out } = runProbe({})
  assert.match(out.split('\n')[0], /^HOVER-PROBE scale=\d+(\.\d+)? pass=\d+ fail=\d+$/)
  assert.deepEqual(Object.keys(parseProbeReport(out)).sort(), ['fail', 'pass', 'scale'])
})

test('运行器：缩放档位与结果解析仍工作', () => {
  assert.deepEqual(SCALES, [0.6, 1, 2])
  assert.deepEqual(parseProbeReport('HOVER-PROBE scale=0.6 pass=14 fail=0'), { scale: 0.6, pass: 14, fail: 0 })
  assert.equal(parseProbeReport('nothing'), null)
  const ok = summarize([{ scale: 0.6, pass: 14, fail: 0 }, { scale: 1, pass: 14, fail: 0 }, { scale: 2, pass: 14, fail: 0 }])
  assert.equal(ok.ok, true)
})
