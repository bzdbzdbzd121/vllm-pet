import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHoverMonitor, shouldRunHoverMonitor } from '../src/main/hover-monitor.js'

/* ------------------------------------------------------------------
 * 穿透模式监控器：纯逻辑、依赖全注入（光标/窗口框/发送/时钟/定时器）。
 * 平台语义由 supported 传入 —— 本文件用 supported=false 断言「Linux 恒关闭零行为」。
 * 硬验收来自阶段 0 裁决 §3「2B」的 E1–E7。
 * ------------------------------------------------------------------ */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOUNDS = { x: 1000, y: 500, width: 240, height: 280 }

/** 假时钟：advance 会按顺序推进时间并触发所有活动定时器回调 */
function fakeClock(stepMs = 100) {
  let t = 0
  let seq = 1
  const jobs = new Map()
  return {
    now: () => t,
    setIntervalFn: (fn, delay) => {
      const id = seq++
      jobs.set(id, { fn, delay })
      return id
    },
    clearIntervalFn: (id) => jobs.delete(id),
    advance: (ms) => {
      const end = t + ms
      while (t < end) {
        t += stepMs
        for (const job of [...jobs.values()]) job.fn()
      }
    },
    active: () => jobs.size
  }
}

function makeMonitor({ cursor = () => BOUNDS.x + 120, bounds = () => BOUNDS, supported = true } = {}) {
  const clock = fakeClock(100)
  const sent = []
  const logs = []
  const monitor = createHoverMonitor({
    supported,
    getCursor: typeof cursor === 'function' ? cursor : () => cursor,
    getBounds: typeof bounds === 'function' ? bounds : () => bounds,
    send: (payload) => sent.push(payload),
    intervalMs: 100,
    seedTtlMs: 1500,
    now: clock.now,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    log: (msg) => logs.push(msg)
  })
  return { monitor, clock, sent, logs }
}

const inside = () => ({ x: BOUNDS.x + 120, y: BOUNDS.y + 140 })
const outside = () => ({ x: 0, y: 0 })
const lastSent = (sent) => sent[sent.length - 1]

/* ---------------- E1 平台不支持：零行为 ---------------- */

test('E1 Linux（supported=false）：不启动定时器、不推送、不改状态', () => {
  const { monitor, clock, sent } = makeMonitor({ supported: false })
  assert.equal(monitor.start(), false, 'start 必须直接返回 false')
  assert.equal(clock.active(), 0, '不得创建任何定时器')
  assert.equal(monitor.isRunning(), false)
  clock.advance(2000)
  assert.deepEqual(sent, [], '不支持时一条消息都不该发（含 hover:cursor 的 null）')
  monitor.reportEvent({ hasCoords: true })
  monitor.sync()
  assert.deepEqual(sent, [], '事件上报/sync 也不得推送')
  assert.equal(monitor.getState().supported, false)
})

/* ---------------- 种子：启动时立刻判一次 ---------------- */

test('种子：启动时光标已在窗口内 → 立刻推一次归一化坐标（解决「启动即在宠物上却不淡化」）', () => {
  const { monitor, sent } = makeMonitor({ cursor: inside })
  assert.equal(monitor.start(), true)
  assert.equal(sent.length, 1, '启动应立刻发一次候选值')
  assert.ok(Math.abs(sent[0].nx - 0.5) < 1e-9, `nx 应为 0.5，实际 ${sent[0].nx}`)
  assert.ok(Math.abs(sent[0].ny - 0.5) < 1e-9, `ny 应为 0.5，实际 ${sent[0].ny}`)
  assert.equal(monitor.isRunning(), true)
})

test('种子：启动时光标在窗口外 → 不发消息（渲染层本来就是未悬停）', () => {
  const { monitor, sent } = makeMonitor({ cursor: outside })
  monitor.start()
  assert.deepEqual(sent, [])
})

/* ---------------- E2 冻结源不得取得权威 ---------------- */

test('E2 冻结源（恒定读数、无事件）：永不改状态，种子 1.5s 过期后撤回并只记一次', () => {
  const { monitor, clock, sent, logs } = makeMonitor({ cursor: inside })
  monitor.start()
  assert.equal(sent.length, 1, '前提：种子已发')
  clock.advance(1000)
  assert.equal(sent.length, 1, '1s 内种子仍然有效（未获证但也不撤回）')
  assert.equal(monitor.getState().source, null, '恒定读数不构成存活证据 → 无权威')
  clock.advance(600) // 累计 1.6s > 1.5s
  assert.deepEqual(lastSent(sent), null, '种子过期必须撤回（不能卡在淡化）')
  assert.equal(logs.length, 1, '过期只记一次日志')
  clock.advance(3000)
  assert.deepEqual(lastSent(sent), null, '之后恒定读数不得再把状态点亮')
  assert.equal(logs.length, 1, '日志不得刷屏')
})

test('E2 冻结源（恒定在窗口外）：全程一条消息都不发', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: outside })
  monitor.start()
  clock.advance(3000)
  assert.deepEqual(sent, [])
  assert.equal(monitor.getState().source, null)
})

test('E2 「≥2 个不同读数」才算存活：动 1px 都不算，动到新位置才算', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  clock.advance(3000)
  assert.equal(monitor.getState().source, null, '始终同一个读数 → 无权威')
  assert.deepEqual(lastSent(sent), null)
})

test('E4 轮询兜底：出现 2 个不同读数 → 取得权威，之后随采样翻转（同值不重复发）', () => {
  let pos = inside()
  const { monitor, clock, sent } = makeMonitor({ cursor: () => pos })
  monitor.start()
  const seedCount = sent.length
  clock.advance(100)
  assert.equal(monitor.getState().source, null, '1 个读数还不够')
  pos = { x: BOUNDS.x + 130, y: BOUNDS.y + 140 } // 第二处读数
  clock.advance(100)
  assert.equal(monitor.getState().source, 'poller', '2 个不同读数 → 轮询取得权威')

  pos = outside()
  clock.advance(100)
  assert.equal(lastSent(sent), null, '光标离开窗口 → 推 null')
  const afterOut = sent.length
  clock.advance(300)
  assert.equal(sent.length, afterOut, '同一读数不重复推送（去重）')

  pos = inside()
  clock.advance(100)
  assert.ok(lastSent(sent) && lastSent(sent).nx > 0.4, '回到窗口内 → 推坐标')
  assert.ok(sent.length > seedCount)
})

/* ---------------- E3 事件源优先 ---------------- */

test('E3 决策窗内收到带坐标的事件 → 事件源取得权威并停轮询', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  assert.equal(monitor.isRunning(), true)
  const ok = monitor.reportEvent({ hasCoords: true })
  assert.equal(ok, true)
  assert.equal(monitor.getState().source, 'events')
  assert.equal(monitor.isRunning(), false, '事件源稳态零轮询')
  assert.equal(clock.active(), 0, '不得残留定时器')
  const count = sent.length
  clock.advance(1000)
  assert.equal(sent.length, count, '事件源接管后不再采样推送')
})

test('E3 无坐标的事件（pointerleave）不算存活证据', () => {
  const { monitor, clock } = makeMonitor({ cursor: inside })
  monitor.start()
  assert.equal(monitor.reportEvent({ hasCoords: false }), false)
  assert.equal(monitor.getState().source, null, 'leave 不能拿到权威')
  assert.equal(monitor.isRunning(), true, '轮询继续（等真正的存活证据）')
  clock.advance(200)
})

test('E5 升级：先轮询取得权威，再来带坐标事件 → 切事件源、停轮询、只记一次', () => {
  let pos = inside()
  const { monitor, clock, logs } = makeMonitor({ cursor: () => pos })
  monitor.start()
  clock.advance(100)
  pos = { x: BOUNDS.x + 140, y: BOUNDS.y + 140 }
  clock.advance(100)
  assert.equal(monitor.getState().source, 'poller', '前提：轮询已取得权威')
  monitor.reportEvent({ hasCoords: true })
  assert.equal(monitor.getState().source, 'events')
  assert.equal(monitor.isRunning(), false, '升级后停轮询')
  monitor.reportEvent({ hasCoords: true })
  assert.equal(logs.filter((l) => /事件源/.test(l)).length, 1, '升级日志只记一次')
})

/* ---------------- E6 异常：失败即关闭，不抛未捕获 ---------------- */

test('E6 采样抛错：清状态、停轮询、只记一次日志、不抛异常', () => {
  let boom = false
  const { monitor, clock, sent, logs } = makeMonitor({
    cursor: () => {
      if (boom) throw new Error('Wayland: no global cursor')
      return inside()
    }
  })
  monitor.start()
  boom = true
  assert.doesNotThrow(() => clock.advance(100))
  assert.equal(monitor.isRunning(), false, '异常后必须停轮询')
  assert.equal(clock.active(), 0, '不得残留定时器')
  assert.deepEqual(lastSent(sent), null, '必须清状态（不能卡在淡化）')
  assert.equal(logs.length, 1, '只记一次')
  assert.equal(monitor.getState().degraded, true)
  clock.advance(500)
  assert.equal(sent.length, 2, '停掉后不再推送')
})

test('E6 非有限坐标：同样按失败处理（fail-closed）', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: () => ({ x: NaN, y: 10 }) })
  monitor.start()
  assert.doesNotThrow(() => clock.advance(100))
  assert.equal(monitor.isRunning(), false)
  assert.deepEqual(lastSent(sent), null)
})

test('E6 失败后重开会话只多记一次日志的上限（不刷屏）', () => {
  const { monitor, clock, logs } = makeMonitor({
    cursor: () => {
      throw new Error('boom')
    }
  })
  monitor.start()
  clock.advance(100)
  monitor.start()
  clock.advance(100)
  monitor.start()
  clock.advance(100)
  assert.equal(logs.length, 1, '连续失败只记一次')
})

/* ---------------- E7 启停与资源 ---------------- */

test('E7 停止：清定时器 + 推 null；重新 start 可再工作（新会话）', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  assert.equal(clock.active(), 1)
  monitor.stop()
  assert.equal(clock.active(), 0, '停止后不得残留定时器')
  assert.equal(monitor.isRunning(), false)
  assert.deepEqual(lastSent(sent), null, '停止要清状态')
  const before = sent.length
  clock.advance(500)
  assert.equal(sent.length, before, '停止后不再推送')

  monitor.start()
  assert.equal(monitor.isRunning(), true, '新会话可以重新启动')
  assert.equal(clock.active(), 1)
})

test('E7 重复 start 不会叠加定时器', () => {
  const { monitor, clock } = makeMonitor({ cursor: inside })
  monitor.start()
  monitor.start()
  monitor.start()
  assert.equal(clock.active(), 1, '会话进行中再 start 必须幂等')
})

test('E7 事件源接管后再 start（如同一会话里 show/resize 触发 sync）不得重启轮询', () => {
  const { monitor, clock } = makeMonitor({ cursor: inside })
  monitor.start()
  monitor.reportEvent({ hasCoords: true })
  assert.equal(monitor.getState().source, 'events')
  monitor.start()
  assert.equal(clock.active(), 0, '事件源会话内不得因为 start 又把轮询拉起来')
})

test('sync（did-finish-load 握手）：强制重发当前光标，即使值没变', () => {
  const { monitor, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  const count = sent.length
  monitor.sync()
  assert.equal(sent.length, count + 1, '握手必须重发一次（不能因去重被吞）')
  assert.deepEqual(lastSent(sent), sent[count], '重发的是同一个值')
  assert.equal(monitor.getState().cursor.nx, sent[count].nx, 'getState 提供给渲染层主动拉取')
})

test('sync（会话未运行时）：不发消息，但仍能给出最近一次状态', () => {
  const { monitor, sent } = makeMonitor({ cursor: inside })
  assert.deepEqual(monitor.getState().cursor, null)
  monitor.sync()
  assert.deepEqual(sent, [])
})

/* ---------------- 运行条件（Linux 恒关闭） ---------------- */

test('shouldRunHoverMonitor：平台不支持时任何条件都为 false（Linux 零行为）', () => {
  const all = { supported: true, clickThrough: true, enabled: true, visible: true, minimized: false, locked: false, smoke: false }
  assert.equal(shouldRunHoverMonitor(all), true, '前提：全满足时该运行')
  assert.equal(shouldRunHoverMonitor({ ...all, supported: false }), false, 'Linux 恒关闭')
  for (const key of ['clickThrough', 'enabled', 'visible']) {
    assert.equal(shouldRunHoverMonitor({ ...all, [key]: false }), false, `${key}=false 不该运行`)
  }
  for (const key of ['minimized', 'locked', 'smoke']) {
    assert.equal(shouldRunHoverMonitor({ ...all, [key]: true }), false, `${key}=true 不该运行`)
  }
})

test('main.js 的平台白名单只有 win32/darwin，Linux 不在其中', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const m = src.match(/HOVER_SUPPORTED_PLATFORMS\s*=\s*\[([^\]]*)\]/)
  assert.ok(m, 'main.js 必须有 HOVER_SUPPORTED_PLATFORMS 常量')
  const platforms = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.deepEqual(platforms.sort(), ['darwin', 'win32'], '只允许 Windows/macOS 进入穿透悬停路径')
  assert.equal(platforms.includes('linux'), false, 'Linux 必须恒 false（上游 #52456 + 读数冻结）')
  assert.match(src, /HOVER_SUPPORTED_PLATFORMS\.includes\(process\.platform\)/, '必须由 process.platform 决定')
})

test('main.js 不得改动点击穿透语义（不碰 setIgnoreMouseEvents 的既有调用形态）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const calls = [...src.matchAll(/setIgnoreMouseEvents\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(calls.length >= 2, '既有两处调用（启动 + 配置变更）应保留')
  for (const arg of calls) assert.match(arg, /\{ forward: true \}$/, `穿透调用形态不得改变：${arg}`)
})
