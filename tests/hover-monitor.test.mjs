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

test('E2 恒定读数（无事件）：不取得权威，但**不因超时撤回**（只记一次「未获证」日志）', () => {
  const { monitor, clock, sent, logs } = makeMonitor({ cursor: inside })
  monitor.start()
  assert.equal(sent.length, 1, '前提：种子已发')
  clock.advance(1000)
  assert.equal(sent.length, 1, '1s 内没有新读数 → 不重复推送')
  assert.equal(monitor.getState().source, null, '恒定读数不构成存活证据 → 无权威')
  clock.advance(600) // 累计 1.6s > 1.5s
  assert.deepEqual(lastSent(sent), { nx: 0.5, ny: 0.5 }, '超时不得撤回（无输入、无离开）')
  assert.equal(logs.length, 1, '「未获证」只记一次日志')
  clock.advance(3000)
  assert.deepEqual(lastSent(sent), { nx: 0.5, ny: 0.5 }, '恒定读数保持当前状态，不点亮也不清除')
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
  assert.deepEqual(lastSent(sent), { nx: 0.5, ny: 0.5 }, '无权威 ≠ 清状态：保持最后一次有效读数')
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

/* ---------------- Windows 穿透会话：无输入时不得清状态（v0.3.2 缺陷） ---------------- */

test('再现 v0.3.2 Windows 缺陷：光标停在宠物上、全程无事件 → 1.5s/3s 后不得清状态', () => {
  // 用户报告：只有开穿透时，手停在宠物上「淡一下就恢复」；移动才保持淡化。
  // 成因：会话启动只发了一次「种子」，种子 1.5s 到期就 emit(null) —— 期间没有任何输入、
  // 也没有任何离开，渲染层收到 null 就当「离开」清掉锁存。非穿透路径没有这段 TTL，所以只在穿透下出现。
  const { monitor, clock, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  assert.deepEqual(sent, [{ nx: 0.5, ny: 0.5 }], '前提：种子已推送（渲染层已淡化）')
  clock.advance(1600)
  assert.deepEqual(lastSent(sent), { nx: 0.5, ny: 0.5 }, '1.6s：手没动、也没离开，不得清状态')
  clock.advance(1400)
  assert.deepEqual(lastSent(sent), { nx: 0.5, ny: 0.5 }, '3s：仍然不得清状态')
  assert.equal(sent.filter((p) => p === null).length, 0, '全程不得出现 null')
  assert.ok(monitor.getState().cursor, 'getState 仍报告在窗口内（调试/诊断口径一致）')
})

test('事件源取得权威后停下 5s：不得清状态（稳态零轮询，只有明确离开才清）', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  monitor.reportEvent({ hasCoords: true })
  assert.equal(monitor.getState().source, 'events')
  const count = sent.length
  clock.advance(5000)
  assert.equal(sent.length, count, '事件源会话里不许有任何自发推送')
  assert.equal(sent.filter((p) => p === null).length, 0, '不许出现 null')
})

test('明确的离开：光标读到窗口外 → 推 null（种子期也算离开）', () => {
  let pos = inside()
  const { monitor, clock, sent } = makeMonitor({ cursor: () => pos })
  monitor.start()
  pos = outside()
  clock.advance(100)
  assert.deepEqual(lastSent(sent), null, '读到窗口外 → 必须清状态（这是唯一的「无事件清状态」依据）')
})

test('隐藏/最小化 → 宿主 stop() → 清状态（明确的停止原因）', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: inside })
  monitor.start()
  monitor.stop() // main.js 的 hide/minimize/lock/关穿透 都走这里
  assert.equal(clock.active(), 0)
  assert.deepEqual(lastSent(sent), null, 'stop 必须推 null 清状态')
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

test('sync（会话未开始）：不采样、不发送（不是「未运行」，事件源会话仍要发）', () => {
  const { monitor, sent } = makeMonitor({ cursor: inside })
  assert.deepEqual(monitor.getState().cursor, null)
  assert.equal(monitor.sync(), null)
  assert.deepEqual(sent, [], '会话没开始就没什么可握手的')
})

test('sync 在事件源会话里必须重采样（不得交出种子/上次推送的残值）', () => {
  let pos = inside()
  const { monitor, sent } = makeMonitor({ cursor: () => pos })
  monitor.start()
  assert.deepEqual(sent, [{ nx: 0.5, ny: 0.5 }], '前提：种子已发')
  monitor.reportEvent({ hasCoords: true })
  assert.equal(monitor.getState().source, 'events', '前提：事件源已取得权威')
  assert.equal(monitor.isRunning(), false, '前提：事件源会话里轮询已停（这正是缺陷场景）')

  pos = { x: 1200, y: 800 } // 光标已移到窗口外
  const payload = monitor.sync()
  assert.equal(payload, null, 'sync 必须按此刻光标采样（窗口外 → null）')
  assert.equal(sent[sent.length - 1], null, '必须把 null 推出去（清状态），不能沿用种子值')
  assert.equal(monitor.getState().cursor, null, '内部状态也要更新，否则握手继续读到残值')
  assert.equal(monitor.isRunning(), false, 'sync 不得重启轮询')
  assert.equal(monitor.getState().source, 'events', 'sync 不得改变权威')
})

test('sync 采样失败 → 返回 null、清状态、停轮询、不抛（fail-closed）', () => {
  let boom = false
  const { monitor, sent, logs } = makeMonitor({
    cursor: () => {
      if (boom) throw new Error('Wayland: no global cursor')
      return inside()
    }
  })
  monitor.start()
  monitor.reportEvent({ hasCoords: true })
  boom = true
  let first
  assert.doesNotThrow(() => { first = monitor.sync() })
  assert.equal(first, null, '采样失败时**第一次**调用就必须返回 null（不能给残值）')
  assert.equal(monitor.sync(), null, '采样失败必须给 null（不能给残值）')
  assert.equal(sent[sent.length - 1], null, '失败也要把状态清掉')
  assert.equal(monitor.isRunning(), false)
  assert.equal(monitor.getState().degraded, true)
  assert.equal(logs.length, 1, '只记一次日志')
})

test('从来没过有效读数（启动即在窗外）时：sync 必须给 null（不点亮无证据的状态）', () => {
  const { monitor, clock, sent } = makeMonitor({ cursor: outside })
  monitor.start() // 启动采样在窗口外 → 没有种子
  clock.advance(1600)
  assert.deepEqual(sent, [], '前提：全程没有推送')
  const before = sent.length

  const payload = monitor.sync()
  assert.equal(payload, null, '既无权威又从未有过有效读数 → 握手给 null')
  assert.equal(sent.length, before, 'null 与「本来就没状态」相同，不必再推一次')
  assert.deepEqual(lastSent(sent), undefined, '状态保持未悬停')
  assert.equal(monitor.getState().source, null, '不得因此授予权威')
})

test('sync 的单次采样不计入存活证据（握手不能绕过权威规则）', () => {
  let pos = inside()
  const { monitor, clock } = makeMonitor({ cursor: () => pos })
  monitor.start() // 第 1 个读数（种子）
  pos = { x: BOUNDS.x + 130, y: BOUNDS.y + 140 } // 第 2 个不同读数
  monitor.sync()
  assert.equal(monitor.getState().source, null, 'sync 采样后仍不得因此取得权威')
  clock.advance(100) // 真正的轮询采样才算
  assert.equal(monitor.getState().source, 'poller', '轮询采样出现 ≥2 个不同读数才授予权威')
})

function bodyOfFn(src, marker) {
  const at = src.indexOf(marker)
  assert.notEqual(at, -1, `找不到 ${marker}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  throw new Error(`${marker} 花括号不配对`)
}

test('握手通道 hover:cursor:get 必须复用 sync 的实时采样，不得返回缓存光标', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const body = bodyOfFn(src, "ipcMain.handle('hover:cursor:get'")
  assert.match(body, /hoverMonitor[\s\S]{0,60}sync\(\)/, '必须调用 hoverMonitor.sync() 做单次采样')
  assert.doesNotMatch(body, /cursor:\s*state\.cursor/, '不得直接返回 getState().cursor 的残值')
  assert.match(body, /cursor:\s*cursor \?\? null/, '返回的必须是用采样结果（失败 → null）')
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
