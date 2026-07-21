import test from 'node:test'
import assert from 'node:assert/strict'
import { PetStateMachine, formatStatusLine, DEFAULT_STATE_MAP } from '../src/renderer/status/state-machine.js'

// 通过 t.after 保证 dispose，避免断言失败时 interval 悬挂导致进程不退出
function makeMachine(t, opts = {}) {
  const visuals = []
  const machine = new PetStateMachine({
    onVisualState: (v) => visuals.push(v),
    onCelebrate: opts.onCelebrate || (() => {}),
    idleSleepMinutes: opts.idleSleepMinutes ?? 10,
    stateMap: opts.stateMap
  })
  t.after(() => machine.dispose())
  return { machine, visuals }
}

const snap = (patch) => ({
  state: 'idle', intensity: 0, running: 0, waiting: 0,
  cacheUsage: null, latencyMs: 10, models: [], error: null, updatedAt: Date.now(),
  ...patch
})

test('状态机：基本状态映射', (t) => {
  const { machine, visuals } = makeMachine(t)
  machine.update(snap({ state: 'offline', error: 'x' }))
  machine.update(snap({ state: 'connecting' }))
  machine.update(snap({ state: 'idle' }))
  machine.update(snap({ state: 'busy', intensity: 1 }))
  machine.update(snap({ state: 'busy', intensity: 2 }))
  machine.update(snap({ state: 'busy', intensity: 3 }))
  assert.deepEqual(visuals, ['offline', 'connecting', 'idle', 'busy-1', 'busy-2', 'busy-3'])
})

test('状态机：自定义动画映射 stateMap', (t) => {
  const { machine, visuals } = makeMachine(t, {
    stateMap: { light: 'busy-3', medium: 'busy-1', heavy: 'busy-2' }
  })
  machine.update(snap({ state: 'busy', intensity: 1 }))
  machine.update(snap({ state: 'busy', intensity: 2 }))
  machine.update(snap({ state: 'busy', intensity: 3 }))
  assert.deepEqual(visuals, ['busy-3', 'busy-1', 'busy-2'])
})

test('状态机：非法动画映射回退默认', (t) => {
  const { machine, visuals } = makeMachine(t, { stateMap: { light: 'not-a-state' } })
  machine.update(snap({ state: 'busy', intensity: 1 }))
  assert.deepEqual(visuals, [DEFAULT_STATE_MAP.light])
})

test('状态机：setStateMap 运行时生效且忽略非法值', (t) => {
  const { machine, visuals } = makeMachine(t)
  machine.setStateMap({ medium: 'busy-3', heavy: 'busy-1' })
  machine.setStateMap({ light: 'bogus' })
  assert.equal(machine.stateMap.light, DEFAULT_STATE_MAP.light) // 非法值被忽略
  machine.update(snap({ state: 'busy', intensity: 2 }))
  machine.update(snap({ state: 'busy', intensity: 3 }))
  assert.deepEqual(visuals, ['busy-3', 'busy-1'])
})

test('状态机：忙碌 → 空闲触发庆祝', (t) => {
  let celebrated = 0
  const { machine } = makeMachine(t, { onCelebrate: () => celebrated++ })
  machine.update(snap({ state: 'busy', intensity: 2 }))
  machine.update(snap({ state: 'idle' }))
  assert.equal(celebrated, 1)
  // 连续 idle 不重复庆祝
  machine.update(snap({ state: 'idle' }))
  assert.equal(celebrated, 1)
})

test('状态机：连续空闲进入睡眠，活动时醒来', async (t) => {
  const { machine, visuals } = makeMachine(t)
  machine.update(snap({ state: 'idle' }))
  machine.idleSleepMs = 40 // 测试用：直接缩短睡眠阈值
  await new Promise((r) => setTimeout(r, 70))
  machine._checkSleep()
  assert.equal(machine.visual, 'sleeping')
  machine.update(snap({ state: 'busy', intensity: 1 }))
  assert.equal(machine.visual, 'busy-1')
  assert.ok(visuals.includes('sleeping'))
})

test('formatStatusLine：未配置/离线/忙碌文案', () => {
  assert.equal(formatStatusLine(snap({ state: 'connecting', error: '尚未配置服务地址' })), '尚未配置服务地址')
  assert.equal(formatStatusLine(snap({ state: 'connecting' })), '连接中…')
  assert.equal(formatStatusLine(snap({ state: 'offline', error: '连接超时' })), '离线：连接超时')
  assert.equal(
    formatStatusLine(snap({ state: 'busy', intensity: 2, running: 6, waiting: 2, cacheUsage: 0.7 })),
    '推理中 ×6 · 队列 2 · KV 70%'
  )
  assert.equal(formatStatusLine(snap({ state: 'idle' })), '空闲中')
})

test('formatStatusLine：tok/s 显示与隐藏规则', () => {
  // > 0 才显示；>= 10 取整，< 10 保留 1 位小数
  assert.equal(
    formatStatusLine(snap({ state: 'busy', intensity: 1, running: 2, tokensPerSec: 86.4 })),
    '推理中 ×2 · 86 tok/s'
  )
  assert.equal(
    formatStatusLine(snap({ state: 'busy', intensity: 1, running: 1, tokensPerSec: 3.26 })),
    '推理中 ×1 · 3.3 tok/s'
  )
  // 0 / null / 负数 不显示
  for (const tokensPerSec of [0, null, -5]) {
    assert.equal(
      formatStatusLine(snap({ state: 'busy', intensity: 1, running: 2, tokensPerSec })),
      '推理中 ×2'
    )
  }
})
