import test from 'node:test'
import assert from 'node:assert/strict'
import { PollerService, describeNetError } from '../src/main/poller-service.js'

/** undici 网络失败时真实原因包在 err.cause.code 里 */
function fetchFail(code) {
  const err = new TypeError('fetch failed')
  err.cause = { code }
  return err
}

test('describeNetError: EPERM → 提示本地网络权限（macOS 未签名应用常见问题）', () => {
  assert.match(describeNetError(fetchFail('EPERM')), /本地网络权限/)
})

test('describeNetError: 拒绝 / 超时 / 解析失败 / 重置各有专属提示', () => {
  assert.match(describeNetError(fetchFail('ECONNREFUSED')), /拒绝/)
  assert.match(describeNetError(fetchFail('ETIMEDOUT')), /超时/)
  assert.match(describeNetError(fetchFail('ENOTFOUND')), /无法解析/)
  assert.match(describeNetError(fetchFail('ECONNRESET')), /重置/)
})

test('describeNetError: 未知错误与空值回退"服务不可达"', () => {
  assert.equal(describeNetError(new Error('x')), '服务不可达')
  assert.equal(describeNetError(null), '服务不可达')
  assert.equal(describeNetError(undefined), '服务不可达')
})

/* ---------------- 采集链路：vLLM / SGLang 指标与 /v1/loads 兜底 ---------------- */

/**
 * 起一个假推理服务。routes: { [path]: (req, res, ctx) => void }
 * 未命中的路径返回 404。
 */
async function startFakeServer(routes) {
  const { createServer } = await import('node:http')
  const hits = {}
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    hits[path] = (hits[path] || 0) + 1
    const handler = routes[path]
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"detail":"Not Found"}')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

function pollConfig(base, patch = {}) {
  return {
    apiBase: base,
    backend: 'auto',
    healthPath: '/health',
    metricsPath: '/metrics',
    pollIntervalMs: 2000,
    thresholds: null,
    ...patch
  }
}

const sglangLoads = (running, waiting, cache, throughput, usedTokens = null) => (_req, res) => {
  const core = { dp_rank: 0, num_running_reqs: running, num_waiting_reqs: waiting, token_usage: cache, gen_throughput: throughput }
  if (usedTokens != null) core.num_used_tokens = usedTokens
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    timestamp: new Date().toISOString(),
    version: '0.5.20',
    dp_rank_count: 1,
    loads: [core],
    aggregate: { total_running_reqs: running, total_waiting_reqs: waiting, avg_token_usage: cache }
  }))
}

/** 真实 SGLang /metrics 形状：gen_throughput + 只在请求结束累加的累计 counter + 每次迭代累加的 realtime counter */
const sglangMetrics = ({ running, waiting, cache, genTotal, realtimeGenTotal, prefillTokens, usedTokens }) => (_req, res) => {
  const label = 'model_name="mock",tp_rank="0",pp_rank="0",moe_ep_rank="0"'
  const lines = [
    `sglang:num_running_reqs{${label}} ${running}.0`,
    `sglang:num_queue_reqs{${label}} ${waiting}.0`,
    `sglang:token_usage{${label}} ${cache}`,
    `sglang:gen_throughput{${label}} 7.0`,
    `sglang:prompt_tokens_total{${label},is_streaming="true"} 500.0`,
    `sglang:generation_tokens_total{${label},is_streaming="true"} ${genTotal}.0`
  ]
  // realtime counter 是 v0.5.x 才有；老版本（或模拟缺失）不吐这行
  if (realtimeGenTotal != null) {
    lines.push(`sglang:realtime_tokens_total{${label},mode="decode"} ${realtimeGenTotal}.0`)
  }
  if (prefillTokens != null) {
    lines.push(`sglang:realtime_tokens_total{${label},mode="prefill_compute"} ${prefillTokens}.0`)
  }
  if (usedTokens != null) {
    lines.push(`sglang:num_used_tokens{${label}} ${usedTokens}.0`)
  }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
  res.end(lines.join('\n') + '\n')
}

test('poller: SGLang 未开 --enable-metrics 时回退 /v1/loads，不再误报"空闲中"', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/v1/loads': sglangLoads(5, 2, 0.5, 210)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const snap = await poller._poll(pollConfig(fake.base))
    assert.equal(snap.state, 'busy')
    assert.equal(snap.intensity, 2) // 并发 5+2 ≥ 4 → 中载
    assert.equal(snap.running, 5)
    assert.equal(snap.waiting, 2)
    assert.equal(snap.cacheUsage, 0.5)
    assert.equal(snap.backend, 'sglang')
    assert.equal(snap.loadSource, 'loads')
    assert.equal(snap.tokensPerSec, 210) // 无 counter → 用服务自报吞吐
    assert.equal(snap.hint, null)
  } finally {
    await fake.close()
  }
})

test('poller: 指定 vllm 模式时不去试探 /v1/loads，降级为仅存活检测并给出提示', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/v1/loads': sglangLoads(5, 2, 0.5, 210)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const snap = await poller._poll(pollConfig(fake.base, { backend: 'vllm' }))
    assert.equal(snap.state, 'idle')
    assert.equal(snap.loadSource, 'none')
    assert.equal(snap.hint, '未读到负载指标')
    assert.equal(fake.hits['/v1/loads'], undefined)
  } finally {
    await fake.close()
  }
})

test('poller: SGLang 计数取实时 /v1/loads，tok/s 仍由 /metrics 的 realtime counter 算', async () => {
  let realtimeGenTotal = 1000
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({ running: 9, waiting: 3, cache: 0.42, genTotal: 1000, realtimeGenTotal })(req, res),
    '/v1/loads': sglangLoads(9, 3, 0.42, 7)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    const first = await poller._poll(cfg)
    assert.equal(first.loadSource, 'loads') // 计数以实时接口为准
    assert.equal(first.backend, 'sglang')
    assert.equal(first.state, 'busy')
    assert.equal(first.running, 9)
    assert.equal(first.tokensPerSec, 7) // 首样本算不出差值 → /metrics 的 gen_throughput 兜底
    realtimeGenTotal += 420
    const second = await poller._poll(cfg)
    assert.ok(second.tokensPerSec > 1000, `应由 realtime counter 差值算出（远大于 gen_throughput=7），实际 ${second.tokensPerSec}`)
    assert.equal(fake.hits['/metrics'], 2) // counter 每轮都取自 /metrics
  } finally {
    await fake.close()
  }
})

test('poller: SGLang 累计 counter 停在请求结束才跳，长请求中也能显示实时 tok/s', async () => {
  // 复现线上现象：generation_tokens_total 在请求进行中恒定不变（只在请求结束时结算），
  // 只拿它求差 → tok/s 一直是 0 → 状态文本里什么都看不到
  let realtimeGenTotal = 5000
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({ running: 6, waiting: 0, cache: 0.3, genTotal: 700, realtimeGenTotal })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    realtimeGenTotal += 300 // genTotal 一动不动（请求还没结束）
    const snap = await poller._poll(cfg)
    assert.ok(snap.tokensPerSec > 0, `应算出正速率，实际 ${snap.tokensPerSec}`)
    assert.equal(snap.state, 'busy')
  } finally {
    await fake.close()
  }
})

test('poller: 老版本 SGLang 没有 realtime counter 时退回 gen_throughput（不再显示 0）', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({ running: 4, waiting: 1, cache: 0.5, genTotal: 700 })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    const snap = await poller._poll(cfg) // 累计 counter 差值为 0
    assert.equal(snap.tokensPerSec, 7) // gen_throughput 兜底
  } finally {
    await fake.close()
  }
})

test('poller: 服务不支持 /v1/loads 时探一次后退避，不每轮重复请求', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok')
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    for (let i = 0; i < 5; i++) await poller._poll(cfg)
    assert.equal(fake.hits['/v1/loads'], 1)
    assert.equal(fake.hits['/metrics'], 5)
  } finally {
    await fake.close()
  }
})

test('poller: vLLM 指标链路不受影响（含新版 kv_cache_usage_perc）', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end([
        'vllm:num_requests_running{model_name="mock"} 3.0',
        'vllm:num_requests_waiting{model_name="mock"} 2.0',
        'vllm:kv_cache_usage_perc{model_name="mock"} 0.91',
        'vllm:generation_tokens_total{model_name="mock"} 4242.0',
        ''
      ].join('\n'))
    }
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const snap = await poller._poll(pollConfig(fake.base))
    assert.equal(snap.backend, 'vllm')
    assert.equal(snap.loadSource, 'metrics')
    assert.equal(snap.running, 3)
    assert.equal(snap.waiting, 2)
    assert.equal(snap.cacheUsage, 0.91)
    assert.equal(snap.state, 'busy')
    assert.equal(snap.intensity, 3) // KV 0.91 ≥ 0.85 → 重载
    assert.equal(fake.hits['/v1/loads'], undefined)
  } finally {
    await fake.close()
  }
})

test('poller: SGLang prefill 阶段（并发 gauge 恒为 0）不再显示"空闲中"', async () => {
  // 真实机制：正在 prefill 的请求被排除在 running_batch 之外（也不在 waiting_queue），
  // 两个 gauge 都是 0；只有 realtime_tokens_total{mode="prefill_*"} 在涨
  let prefillTokens = 1000
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({
      running: 0, waiting: 0, cache: 0.3, genTotal: 700, prefillTokens
    })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    const first = await poller._poll(cfg)
    assert.equal(first.state, 'idle') // 首个样本没有对比基线，只能按 gauge 判
    assert.equal(first.running, 0)
    prefillTokens += 4200 // prefill 推进了一次 chunk
    const second = await poller._poll(cfg)
    assert.equal(second.state, 'busy') // ← 修复点：以前这里是 idle
    assert.equal(second.intensity, 1)
    assert.equal(second.prefillActive, true)
    assert.equal(second.running, 0)
    // prefill 结束、计数停住 → 回到空闲
    const third = await poller._poll(cfg)
    assert.equal(third.state, 'idle')
  } finally {
    await fake.close()
  }
})

test('poller: 未开 metrics（/v1/loads 路径）时靠 KV 占用增长识别 prefill', async () => {
  let usedTokens = 4000
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/v1/loads': (req, res) => sglangLoads(0, 0, 0.3, 0, usedTokens)(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    assert.equal((await poller._poll(cfg)).state, 'idle')
    usedTokens += 20000 // prefill 往 KV 池里装 token
    const snap = await poller._poll(cfg)
    assert.equal(snap.state, 'busy') // ← 修复点
    assert.equal(snap.running, 0)
    assert.equal(snap.loadSource, 'loads')
  } finally {
    await fake.close()
  }
})

test('poller: 真空闲不能被误判成忙碌（计数/gauge 全持平）', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({
      running: 0, waiting: 0, cache: 0.2, genTotal: 700, realtimeGenTotal: 500, prefillTokens: 900, usedTokens: 3000
    })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    const snap = await poller._poll(cfg)
    assert.equal(snap.state, 'idle')
    assert.equal(snap.prefillActive, false)
  } finally {
    await fake.close()
  }
})

test('poller: gauge 冻结在旧值、/v1/loads 报 0 → 必须判空闲（复现"不回空闲中"）', async () => {
  // SGLang 上游 PR #26495：调度器空闲后 num_running_reqs 会冻结在最后一批的数值上（实测 30s），
  // 此时 /metrics 一直报 8，而 /v1/loads 是请求时现算的 0
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({
      running: 8, waiting: 0, cache: 0.4, genTotal: 700, realtimeGenTotal: 500, prefillTokens: 900
    })(req, res),
    '/v1/loads': (req, res) => sglangLoads(0, 0, 0.4, 0, 3000)(req, res) // 实时值：真的空闲
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    const snap = await poller._poll(cfg)
    assert.equal(snap.loadSource, 'loads') // 计数取自实时接口
    assert.equal(snap.running, 0)
    assert.equal(snap.state, 'idle') // ← 修复点：以前会被冻结的 gauge 拖着一直"忙碌"
  } finally {
    await fake.close()
  }
})

test('poller: gauge 冻结但服务确实在忙时（/v1/loads 也忙）仍是忙碌', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({
      running: 8, waiting: 0, cache: 0.4, genTotal: 700, realtimeGenTotal: 500, prefillTokens: 900
    })(req, res),
    '/v1/loads': (req, res) => sglangLoads(5, 1, 0.6, 88, 9000)(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    const snap = await poller._poll(cfg)
    assert.equal(snap.running, 5) // 以 /v1/loads 为准
    assert.equal(snap.waiting, 1)
    assert.equal(snap.cacheUsage, 0.6)
    assert.equal(snap.state, 'busy')
    assert.equal(snap.intensity, 2)
    assert.equal(snap.tokensPerSec > 0, true) // counter 仍来自 /metrics
  } finally {
    await fake.close()
  }
})

test('poller: 只有 /metrics（无 /v1/loads）时计数回落到 gauge', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({
      running: 3, waiting: 0, cache: 0.4, genTotal: 700, realtimeGenTotal: 500, prefillTokens: 900
    })(req, res)
    // /v1/loads 未注册 → 404
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    const snap = await poller._poll(cfg)
    assert.equal(snap.loadSource, 'metrics')
    assert.equal(snap.running, 3)
    assert.equal(snap.state, 'busy')
  } finally {
    await fake.close()
  }
})

test('poller: 优先用非生成式的 /ready 判活，不触发 SGLang 的 1 token 健康生成', async () => {
  let healthHits = 0
  const fake = await startFakeServer({
    '/ready': (_req, res) => res.writeHead(200).end('ok'),
    '/health': (_req, res) => { healthHits += 1; res.writeHead(200).end('ok') },
    '/metrics': (req, res) => sglangMetrics({ running: 0, waiting: 0, cache: 0.3, genTotal: 700 })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    await poller._poll(cfg)
    assert.equal(healthHits, 0) // 一次都没打会触发生成的 /health
    assert.equal(fake.hits['/ready'], 2)
  } finally {
    await fake.close()
  }
})

test('poller: 没有 /ready（vLLM / 老版本）时回落 healthPath，且只探一次 /ready', async () => {
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({ running: 2, waiting: 0, cache: 0.3, genTotal: 700 })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    const a = await poller._poll(cfg)
    const b = await poller._poll(cfg)
    assert.equal(a.state, 'busy')
    assert.equal(b.state, 'busy')
    assert.equal(fake.hits['/ready'], 1) // 404 后记住不再重复探
    assert.equal(fake.hits['/health'], 2)
  } finally {
    await fake.close()
  }
})

test('poller: 自定义 healthPath 时不被 /ready 取代（尊重用户配置）', async () => {
  const fake = await startFakeServer({
    '/ready': (_req, res) => res.writeHead(200).end('ok'),
    '/health_generate': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics({ running: 0, waiting: 0, cache: 0.3, genTotal: 700 })(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base, { healthPath: '/health_generate' })
    await poller._poll(cfg)
    assert.equal(fake.hits['/ready'], undefined)
    assert.equal(fake.hits['/health_generate'], 1)
  } finally {
    await fake.close()
  }
})

test('poller: /health 会生成 token 的服务（无 /ready）——不该拿它判活，否则自己的探活会被数成在跑', async () => {
  // 复现线上现象：SGLang 的 /health 默认真生成 1 个 token，那个请求会短暂出现在
  // running_batch 里，被 /v1/loads 数成"正在运行" → 空闲时一直显示"推理中 ×1 · 0.5 tok/s"
  let phantom = 0
  const fake = await startFakeServer({
    '/health': (_req, res) => { phantom = 1; res.writeHead(200).end('ok') }, // 触发生成 → 服务里出现 1 个在跑请求
    '/v1/models': (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}') },
    '/metrics': (req, res) => sglangMetrics({ running: phantom, waiting: 0, cache: 0.3, genTotal: 700, realtimeGenTotal: 0 })(req, res),
    '/v1/loads': (req, res) => sglangLoads(phantom, 0, 0.3, 0, 3000)(req, res)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    await poller._poll(cfg)
    const snap = await poller._poll(cfg)
    assert.equal(fake.hits['/health'], undefined) // 绝不能打会触发生成的 /health
    assert.equal(snap.state, 'idle') // ← 修复点：以前会被自己的探活顶成 busy
    assert.equal(snap.running, 0)
  } finally {
    await fake.close()
  }
})
