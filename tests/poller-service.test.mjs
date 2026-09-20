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

const sglangLoads = (running, waiting, cache, throughput) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    timestamp: new Date().toISOString(),
    version: '0.5.20',
    dp_rank_count: 1,
    loads: [{ dp_rank: 0, num_running_reqs: running, num_waiting_reqs: waiting, token_usage: cache, gen_throughput: throughput }],
    aggregate: { total_running_reqs: running, total_waiting_reqs: waiting, avg_token_usage: cache }
  }))
}

const sglangMetrics = (running, waiting, cache, genTotal) => (_req, res) => {
  const label = 'model_name="mock",tp_rank="0",pp_rank="0",moe_ep_rank="0"'
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
  res.end([
    `sglang:num_running_reqs{${label}} ${running}.0`,
    `sglang:num_queue_reqs{${label}} ${waiting}.0`,
    `sglang:token_usage{${label}} ${cache}`,
    `sglang:gen_throughput{${label}} 7.0`,
    `sglang:prompt_tokens_total{${label},is_streaming="true"} 500.0`,
    `sglang:generation_tokens_total{${label},is_streaming="true"} ${genTotal}.0`,
    ''
  ].join('\n'))
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

test('poller: 读到 sglang:* 指标时不走兜底，tok/s 由 counter 差值算出', async () => {
  let genTotal = 1000
  const fake = await startFakeServer({
    '/health': (_req, res) => res.writeHead(200).end('ok'),
    '/metrics': (req, res) => sglangMetrics(9, 3, 0.42, genTotal)(req, res),
    '/v1/loads': sglangLoads(9, 3, 0.42, 7)
  })
  try {
    const poller = new PollerService({ getConfig: () => ({}), onStatus: () => {} })
    const cfg = pollConfig(fake.base)
    const first = await poller._poll(cfg)
    assert.equal(first.loadSource, 'metrics')
    assert.equal(first.backend, 'sglang')
    assert.equal(first.state, 'busy')
    assert.equal(first.tokensPerSec, null) // 首个采样算不出速率
    genTotal += 420
    const second = await poller._poll(cfg)
    assert.ok(second.tokensPerSec > 1000, `应由 counter 差值算出（远大于 gen_throughput=7），实际 ${second.tokensPerSec}`)
    assert.equal(fake.hits['/v1/loads'], undefined)
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
