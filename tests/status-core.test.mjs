import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePrometheusMetrics,
  parseLoadsResponse,
  deriveState,
  tokenRate,
  DEFAULT_THRESHOLDS
} from '../src/shared/status-core.js'

const SAMPLE = `# HELP vllm:num_requests_running Number of requests currently running on GPU.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="qwen3"} 3.0
vllm:num_requests_waiting{model_name="qwen3"} 2.0
# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage.
# TYPE vllm:gpu_cache_usage_perc gauge
vllm:gpu_cache_usage_perc{model_name="qwen3"} 0.42
vllm:prompt_tokens_total{model_name="qwen3"} 12345.0
`

/** SGLang /metrics（--enable-metrics）真实形状：多 label + gen_throughput + is_streaming counter */
const SGLANG_SAMPLE = `# HELP sglang:num_running_reqs The number of running requests.
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"} 7.0
# HELP sglang:num_queue_reqs The number of requests in the waiting queue.
# TYPE sglang:num_queue_reqs gauge
sglang:num_queue_reqs{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"} 3.0
# HELP sglang:token_usage The token usage
# TYPE sglang:token_usage gauge
sglang:token_usage{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"} 0.66
# HELP sglang:gen_throughput The generate throughput (token/s)
# TYPE sglang:gen_throughput gauge
sglang:gen_throughput{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"} 294.5
# HELP sglang:prompt_tokens_total Number of prefill tokens processed.
# TYPE sglang:prompt_tokens_total counter
sglang:prompt_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",is_streaming="true"} 8.128902e+06
# HELP sglang:generation_tokens_total Number of generation tokens processed.
# TYPE sglang:generation_tokens_total counter
sglang:generation_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",is_streaming="true"} 7.557572e+06
`

const EMPTY = {
  backend: null,
  hasConcurrency: false,
  running: 0,
  waiting: 0,
  cacheUsage: null,
  promptTokensTotal: null,
  genTokensTotal: null,
  genThroughput: null
}

test('parsePrometheusMetrics: 忽略注释行并解析核心指标', () => {
  const m = parsePrometheusMetrics(SAMPLE)
  assert.equal(m.running, 3)
  assert.equal(m.waiting, 2)
  assert.equal(m.cacheUsage, 0.42)
  assert.equal(m.backend, 'vllm')
  assert.equal(m.hasConcurrency, true)
})

test('parsePrometheusMetrics: 带不同 label 的同名指标求和', () => {
  const text = [
    'vllm:num_requests_running{model_name="a"} 2.0',
    'vllm:num_requests_running{model_name="b"} 5.0',
    'vllm:num_requests_waiting 1.0'
  ].join('\n')
  const m = parsePrometheusMetrics(text)
  assert.equal(m.running, 7)
  assert.equal(m.waiting, 1)
})

test('parsePrometheusMetrics: 缺失指标返回 0 / null', () => {
  const m = parsePrometheusMetrics('vllm:num_requests_running 2\n')
  assert.deepEqual(m, { ...EMPTY, backend: 'vllm', hasConcurrency: true, running: 2 })
})

test('parsePrometheusMetrics: 非法输入不抛异常', () => {
  assert.deepEqual(parsePrometheusMetrics(undefined), EMPTY)
  assert.deepEqual(parsePrometheusMetrics('not a metric at all'), EMPTY)
  // 不带边界匹配，避免误匹配 _total 后缀指标
  const m = parsePrometheusMetrics('vllm:num_requests_running_total 99\n')
  assert.equal(m.running, 0)
})

test('parsePrometheusMetrics: token counters 跨 label 求和，缺失为 null', () => {
  const text = [
    'vllm:prompt_tokens_total{model_name="a"} 100.0',
    'vllm:prompt_tokens_total{model_name="b"} 50.0',
    'vllm:generation_tokens_total{model_name="a"} 800.0',
    'vllm:generation_tokens_total{model_name="b"} 400.0'
  ].join('\n')
  const m = parsePrometheusMetrics(text)
  assert.equal(m.promptTokensTotal, 150)
  assert.equal(m.genTokensTotal, 1200)
  // 只有 prompt 没有 generation 时，generation 仍为 null（老版本兼容）
  const only = parsePrometheusMetrics('vllm:prompt_tokens_total 9\n')
  assert.equal(only.promptTokensTotal, 9)
  assert.equal(only.genTokensTotal, null)
})

test('parsePrometheusMetrics: 识别 SGLang 指标族（sglang:* 与 vllm:* 同一套字段）', () => {
  const m = parsePrometheusMetrics(SGLANG_SAMPLE)
  assert.equal(m.backend, 'sglang')
  assert.equal(m.hasConcurrency, true)
  assert.equal(m.running, 7)
  assert.equal(m.waiting, 3)
  assert.equal(m.cacheUsage, 0.66)
  assert.equal(m.promptTokensTotal, 8.128902e6)
  assert.equal(m.genTokensTotal, 7.557572e6)
  assert.equal(m.genThroughput, 294.5)
})

test('parsePrometheusMetrics: 多 DP rank 的 SGLang 指标求和成总量', () => {
  const text = [
    'sglang:num_running_reqs{model_name="a",tp_rank="0",dp_rank="0"} 2.0',
    'sglang:num_running_reqs{model_name="a",tp_rank="0",dp_rank="1"} 5.0',
    'sglang:num_queue_reqs{model_name="a",tp_rank="0",dp_rank="0"} 1.0',
    'sglang:num_queue_reqs{model_name="a",tp_rank="0",dp_rank="1"} 3.0'
  ].join('\n')
  const m = parsePrometheusMetrics(text)
  assert.equal(m.running, 7)
  assert.equal(m.waiting, 4)
})

test('parsePrometheusMetrics: SGLang priority 分档只取总量行（不重复计数）', () => {
  const text = [
    'sglang:num_running_reqs{model_name="a",priority=""} 10.0',
    'sglang:num_running_reqs{model_name="a",priority="0"} 6.0',
    'sglang:num_running_reqs{model_name="a",priority="1"} 4.0',
    'sglang:num_queue_reqs{model_name="a",priority=""} 2.0',
    'sglang:num_queue_reqs{model_name="a",priority="0"} 2.0'
  ].join('\n')
  const m = parsePrometheusMetrics(text)
  assert.equal(m.running, 10)
  assert.equal(m.waiting, 2)
})

test('parsePrometheusMetrics: 没有总量行时退回分档求和', () => {
  const text = [
    'sglang:num_running_reqs{model_name="a",priority="0"} 6.0',
    'sglang:num_running_reqs{model_name="a",priority="1"} 4.0'
  ].join('\n')
  assert.equal(parsePrometheusMetrics(text).running, 10)
})

test('parsePrometheusMetrics: 不误吞同前缀指标（_by_reason / _offline_batch / full_token_usage）', () => {
  const text = [
    'vllm:num_requests_waiting_by_reason{model_name="a",reason="capacity"} 5.0',
    'sglang:num_running_reqs_offline_batch{model_name="a"} 3.0',
    'sglang:full_token_usage{model_name="a"} 0.9'
  ].join('\n')
  const m = parsePrometheusMetrics(text)
  assert.equal(m.running, 0)
  assert.equal(m.waiting, 0)
  assert.equal(m.cacheUsage, null)
  assert.equal(m.backend, null)
  assert.equal(m.hasConcurrency, false)
})

test('parsePrometheusMetrics: vLLM 新版 KV cache 指标名 kv_cache_usage_perc 也认', () => {
  const m = parsePrometheusMetrics('vllm:kv_cache_usage_perc{model_name="a"} 0.91\n')
  assert.equal(m.cacheUsage, 0.91)
  assert.equal(m.backend, 'vllm')
  assert.equal(m.hasConcurrency, false) // 只有 cache，没有并发指标
})

test('parsePrometheusMetrics: 比率类指标跨 label 取最大值（任一 rank 打满都算重载）', () => {
  const text = [
    'vllm:num_requests_running{model_name="a"} 1.0',
    'sglang:token_usage{model_name="a",dp_rank="0"} 0.31',
    'sglang:token_usage{model_name="a",dp_rank="1"} 0.93'
  ].join('\n')
  assert.equal(parsePrometheusMetrics(text).cacheUsage, 0.93)
})

test('parseLoadsResponse: 解析 SGLang /v1/loads（多 DP 求和）', () => {
  const data = {
    timestamp: '2026-01-01T00:00:00Z',
    version: '0.5.20',
    dp_rank_count: 2,
    loads: [
      { dp_rank: 0, num_running_reqs: 4, num_waiting_reqs: 1, token_usage: 0.4, gen_throughput: 120.5 },
      { dp_rank: 1, num_running_reqs: 6, num_waiting_reqs: 2, token_usage: 0.7, gen_throughput: 80 }
    ],
    aggregate: { total_running_reqs: 10, total_waiting_reqs: 3, avg_token_usage: 0.55 }
  }
  const m = parseLoadsResponse(data)
  assert.equal(m.backend, 'sglang')
  assert.equal(m.hasConcurrency, true)
  assert.equal(m.running, 10)
  assert.equal(m.waiting, 3)
  assert.equal(m.cacheUsage, 0.7) // 取最大而非平均
  assert.equal(m.genThroughput, 200.5)
  assert.equal(m.genTokensTotal, null) // 没有 counter：tok/s 由 genThroughput 兜底
})

test('parseLoadsResponse: 兼容旧 /get_load 记录数组（只有 num_reqs）', () => {
  const m = parseLoadsResponse([{ dp_rank: 0, num_reqs: 9, num_waiting_reqs: 2 }])
  assert.equal(m.running, 7)
  assert.equal(m.waiting, 2)
})

test('parseLoadsResponse: 非 SGLang 负载接口的响应一律返回 null', () => {
  assert.equal(parseLoadsResponse(null), null)
  assert.equal(parseLoadsResponse('nope'), null)
  assert.equal(parseLoadsResponse({ detail: 'Not Found' }), null)
  assert.equal(parseLoadsResponse({ load: 12345 }), null) // 老版 /get_load：只有 token 负载
  assert.equal(parseLoadsResponse({ loads: [] }), null)
})

test('tokenRate: 两次采样求速率', () => {
  const prev = { value: 1000, at: 10_000 }
  const curr = { value: 1420, at: 15_000 }
  assert.equal(tokenRate(prev, curr), 84) // 420 tok / 5 s
})

test('tokenRate: 无法计算时返回 null', () => {
  assert.equal(tokenRate(null, { value: 1, at: 1000 }), null) // 首个样本
  assert.equal(tokenRate({ value: 1, at: 1000 }, null), null)
  assert.equal(tokenRate({ value: 5, at: 1000 }, { value: 9, at: 1000 }), null) // 间隔为 0
  assert.equal(tokenRate({ value: 900, at: 1000 }, { value: 10, at: 3000 }), null) // 服务重启 counter 清零
})

test('deriveState: healthOk=false → offline', () => {
  assert.deepEqual(deriveState({ healthOk: false, metrics: null }), { state: 'offline', intensity: 0 })
})

test('deriveState: 无 metrics（老版本服务）→ idle', () => {
  assert.deepEqual(deriveState({ healthOk: true, metrics: null }), { state: 'idle', intensity: 0 })
})

test('deriveState: 各负载分档', () => {
  const mk = (running, waiting = 0, cacheUsage = null) => ({ running, waiting, cacheUsage })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(0) }), { state: 'idle', intensity: 0 })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(1) }), { state: 'busy', intensity: 1 })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(3) }), { state: 'busy', intensity: 1 })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(4) }), { state: 'busy', intensity: 2 })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(2, 3) }), { state: 'busy', intensity: 2 })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(16) }), { state: 'busy', intensity: 3 })
  assert.deepEqual(deriveState({ healthOk: true, metrics: mk(100) }), { state: 'busy', intensity: 3 })
})

test('deriveState: KV cache 占用触发重载', () => {
  const m = { running: 2, waiting: 0, cacheUsage: 0.9 }
  assert.deepEqual(deriveState({ healthOk: true, metrics: m }), { state: 'busy', intensity: 3 })
})

test('deriveState: 自定义 thresholds 覆盖默认值', () => {
  const m = { running: 2, waiting: 0, cacheUsage: null }
  const t = { ...DEFAULT_THRESHOLDS, medium: 2 }
  assert.deepEqual(deriveState({ healthOk: true, metrics: m }, t), { state: 'busy', intensity: 2 })
})

test('端到端：SGLang 指标 → busy（旧版只认 vllm:* 时这里会误判为限闲）', () => {
  for (const sample of [SGLANG_SAMPLE, SAMPLE]) {
    const metrics = parsePrometheusMetrics(sample)
    // 两族指标分别给出 7+3 / 3+2 并发，都落在中载档（≥4）
    assert.deepEqual(deriveState({ healthOk: true, metrics }, DEFAULT_THRESHOLDS), { state: 'busy', intensity: 2 })
  }
})
test('parsePrometheusMetrics: 兼容 CRLF 换行与行首缩进', () => {
  const text = '  vllm:num_requests_running{model_name="a"} 4.0\r\nvllm:num_requests_waiting{model_name="a"} 1.0\r\n'
  const m = parsePrometheusMetrics(text)
  assert.equal(m.running, 4)
  assert.equal(m.waiting, 1)
})
