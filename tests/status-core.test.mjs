import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePrometheusMetrics,
  parseLoadsResponse,
  deriveState,
  tokenRate,
  sampleGenerationRate,
  sampleActivity,
  mergeLoads,
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
# HELP sglang:num_used_tokens The number of used tokens
# TYPE sglang:num_used_tokens gauge
sglang:num_used_tokens{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"} 123859.0
# HELP sglang:gen_throughput The generate throughput (token/s)
# TYPE sglang:gen_throughput gauge
sglang:gen_throughput{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"} 294.5
# HELP sglang:prompt_tokens_total Number of prefill tokens processed.
# TYPE sglang:prompt_tokens_total counter
sglang:prompt_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",is_streaming="true"} 8.128902e+06
# HELP sglang:generation_tokens_total Number of generation tokens processed.
# TYPE sglang:generation_tokens_total counter
sglang:generation_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",is_streaming="true"} 7.557572e+06
# HELP sglang:realtime_tokens_total The realtime number of tokens processed.
# TYPE sglang:realtime_tokens_total counter
sglang:realtime_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",mode="prefill_compute"} 8128902.0
sglang:realtime_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",mode="prefill_cache"} 0.0
sglang:realtime_tokens_total{model_name="qwen3",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0",mode="decode"} 7557572.0
`

const EMPTY = {
  backend: null,
  hasConcurrency: false,
  running: 0,
  waiting: 0,
  cacheUsage: null,
  promptTokensTotal: null,
  genTokensTotal: null,
  realtimeGenTokensTotal: null,
  prefillTokensTotal: null,
  usedTokensTotal: null,
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
      { dp_rank: 0, num_running_reqs: 4, num_waiting_reqs: 1, token_usage: 0.4, gen_throughput: 120.5, num_used_tokens: 4000 },
      { dp_rank: 1, num_running_reqs: 6, num_waiting_reqs: 2, token_usage: 0.7, gen_throughput: 80, num_used_tokens: 6000 }
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
  assert.equal(m.usedTokensTotal, 10000) // 无 counter 时用它当活动信号
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

test('parsePrometheusMetrics: SGLang realtime_tokens_total 只取 mode="decode" 作输出 token', () => {
  const m = parsePrometheusMetrics(SGLANG_SAMPLE)
  assert.equal(m.realtimeGenTokensTotal, 7_557_572) // prefill_compute / prefill_cache 不计入
  assert.equal(m.genTokensTotal, 7_557_572) // 累计 counter 照旧
})

test('parsePrometheusMetrics: 多 DP rank 的 realtime decode counter 求和', () => {
  const text = [
    'sglang:realtime_tokens_total{model_name="a",dp_rank="0",mode="decode"} 100.0',
    'sglang:realtime_tokens_total{model_name="a",dp_rank="1",mode="decode"} 250.0',
    'sglang:realtime_tokens_total{model_name="a",dp_rank="0",mode="prefill_compute"} 900.0'
  ].join('\n')
  assert.equal(parsePrometheusMetrics(text).realtimeGenTokensTotal, 350)
})

test('sampleGenerationRate: 优先 realtime（每次迭代累加）counter，不等请求结束', () => {
  const at = 10_000
  const load = { realtimeGenTokensTotal: 5000, genTokensTotal: 999, genThroughput: 42 }
  const first = sampleGenerationRate(load, null, at)
  assert.deepEqual(first, { tokensPerSec: 42, sample: { value: 5000, at, source: 'realtime' } }) // 首样本算不出 → 自报吞吐兜底
  const second = sampleGenerationRate({ ...load, realtimeGenTokensTotal: 5400 }, first.sample, at + 2000)
  assert.equal(second.tokensPerSec, 200) // 2s 内 400 token
  assert.equal(second.sample.source, 'realtime')
})

test('sampleGenerationRate: 只有累计 counter（vLLM）时按差值算，差值 0 则不出数', () => {
  const load = { genTokensTotal: 1000, genThroughput: null }
  const first = sampleGenerationRate(load, null, 1000)
  assert.equal(first.tokensPerSec, null) // 首样本
  assert.equal(first.sample.source, 'total')
  const second = sampleGenerationRate({ genTokensTotal: 1420 }, first.sample, 6000)
  assert.equal(second.tokensPerSec, 84)
  const flat = sampleGenerationRate({ genTokensTotal: 1420 }, second.sample, 8000)
  assert.equal(flat.tokensPerSec, 0)
})

test('sampleGenerationRate: SGLang 累计 counter 停在请求结束才跳时，退回自报吞吐', () => {
  // 复现"显示不出输出 token 速率"：generation_tokens_total 在请求进行中不增长
  const load = { genTokensTotal: 700, realtimeGenTokensTotal: null, genThroughput: 294 }
  const first = sampleGenerationRate(load, null, 1000)
  assert.equal(first.tokensPerSec, 294)
  const second = sampleGenerationRate(load, first.sample, 3000)
  assert.equal(second.tokensPerSec, 294) // 差值为 0 → 用 gen_throughput
})

test('sampleGenerationRate: counter 源切换/服务重启（差值为负）时不吐垃圾值', () => {
  const first = sampleGenerationRate({ genTokensTotal: 5000 }, null, 1000)
  // 出现 realtime counter（源切换）→ 丢弃旧样本，用自报吞吐
  const switched = sampleGenerationRate({ realtimeGenTokensTotal: 10, genTokensTotal: 5000, genThroughput: 88 }, first.sample, 3000)
  assert.equal(switched.tokensPerSec, 88)
  assert.equal(switched.sample.source, 'realtime')
  // 服务重启：counter 清零 → 差值为负 → tokenRate 返回 null
  const restarted = sampleGenerationRate({ realtimeGenTokensTotal: 3, genThroughput: null }, switched.sample, 5000)
  assert.equal(restarted.tokensPerSec, null)
})

test('sampleGenerationRate: 无任何数据时返回 null，不误报 0', () => {
  assert.deepEqual(sampleGenerationRate(null, null, 0), { tokensPerSec: null, sample: null })
  assert.deepEqual(sampleGenerationRate({}, null, 0), { tokensPerSec: null, sample: null })
})

test('parseLoadsResponse: /v1/loads 无 counter，tok/s 由 gen_throughput 兜底', () => {
  const load = parseLoadsResponse({ loads: [{ num_running_reqs: 2, num_waiting_reqs: 0, gen_throughput: 126.5 }] })
  const { tokensPerSec, sample } = sampleGenerationRate(load, null, 0)
  assert.equal(tokensPerSec, 126.5)
  assert.equal(sample, null)
})

test('parsePrometheusMetrics: prefill 迭代计数与 KV 占用（prefill 盲区靠它们识别）', () => {
  const m = parsePrometheusMetrics(SGLANG_SAMPLE)
  assert.equal(m.prefillTokensTotal, 8_128_902) // prefill_compute 8128902 + prefill_cache 0
  assert.equal(m.usedTokensTotal, 123_859)
})

test('sampleActivity: 首样本不算活动（重启/改配置后不会立刻误报忙碌）', () => {
  const load = { prefillTokensTotal: 100, realtimeGenTokensTotal: 50, usedTokensTotal: 10 }
  const first = sampleActivity(load, null, 1000)
  assert.equal(first.active, false)
  assert.equal(first.prefillActive, false)
  assert.deepEqual(first.sample, { prefillTokens: 100, decodeTokens: 50, usedTokens: 10, at: 1000 })
  // 两帧时间戳相同时也不判定活动
  assert.equal(sampleActivity(load, first.sample, 1000).active, false)
})

test('sampleActivity: prefill counter 增长 → 活动（SGLang chunked prefill 期间 running/waiting 都是 0）', () => {
  const prev = { prefillTokens: 1000, decodeTokens: 0, usedTokens: 0, at: 1000 }
  const { active, prefillActive } = sampleActivity(
    { prefillTokensTotal: 4200, realtimeGenTokensTotal: 0, usedTokensTotal: 900 },
    prev, 3000
  )
  assert.equal(active, true)
  assert.equal(prefillActive, true)
})

test('sampleActivity: decode counter 增长 → 活动（并发 gauge 默认每 40 次迭代才刷新）', () => {
  const prev = { prefillTokens: 1000, decodeTokens: 800, usedTokens: 900, at: 1000 }
  const { active, prefillActive } = sampleActivity(
    { prefillTokensTotal: 1000, realtimeGenTokensTotal: 820, usedTokensTotal: 900 },
    prev, 3000
  )
  assert.equal(active, true)
  assert.equal(prefillActive, false) // 不是 prefill：状态文本仍显示"推理中"
})

test('sampleActivity: 有 counter 时不拿 KV 占用增长当信号（防多 rank label 跳变误判）', () => {
  const prev = { prefillTokens: 1000, decodeTokens: 800, usedTokens: 100, at: 1000 }
  const beyond = sampleActivity(
    { prefillTokensTotal: 1000, realtimeGenTokensTotal: 800, usedTokensTotal: 99999 },
    prev, 3000
  )
  assert.equal(beyond.active, false)
})

test('sampleActivity: 无 counter（/v1/loads 路径）时用 KV 占用增长兜底', () => {
  const prev = { prefillTokens: null, decodeTokens: null, usedTokens: 4000, at: 1000 }
  assert.equal(sampleActivity({ usedTokensTotal: 9000 }, prev, 3000).active, true)
  assert.equal(sampleActivity({ usedTokensTotal: 4000 }, prev, 3000).active, false)
  assert.equal(sampleActivity({ usedTokensTotal: 1000 }, prev, 3000).active, false) // 回落（释放 KV）不算活动
})

test('sampleActivity: 全部持平 → 不活动（真空闲不能被误判成忙碌）', () => {
  const load = { prefillTokensTotal: 5000, realtimeGenTokensTotal: 700, usedTokensTotal: 8000 }
  const prev = { prefillTokens: 5000, decodeTokens: 700, usedTokens: 8000, at: 1000 }
  assert.equal(sampleActivity(load, prev, 3000).active, false)
})

test('deriveState: gauge 为 0 但在推进 → busy（prefill 阶段不再误报空闲）', () => {
  const metrics = { running: 0, waiting: 0, cacheUsage: 0.3 }
  assert.deepEqual(deriveState({ healthOk: true, metrics, active: true }), { state: 'busy', intensity: 1 })
  assert.deepEqual(deriveState({ healthOk: true, metrics, active: false }), { state: 'idle', intensity: 0 })
  // 并发确实为 0 且无活动 → 空闲
  assert.deepEqual(deriveState({ healthOk: true, metrics }), { state: 'idle', intensity: 0 })
})

test('mergeLoads: 计数用实时 /v1/loads，counter/tok-s 仍用 /metrics', () => {
  const metrics = {
    backend: 'sglang', hasConcurrency: true, running: 8, waiting: 0, cacheUsage: 0.4,
    promptTokensTotal: 100, genTokensTotal: 700, realtimeGenTokensTotal: 500,
    prefillTokensTotal: 900, usedTokensTotal: 3000, genThroughput: 42
  }
  const live = {
    backend: 'sglang', hasConcurrency: true, running: 0, waiting: 0, cacheUsage: 0.4,
    promptTokensTotal: null, genTokensTotal: null, realtimeGenTokensTotal: null,
    prefillTokensTotal: null, usedTokensTotal: 3000, genThroughput: 0
  }
  const merged = mergeLoads(live, metrics)
  assert.equal(merged.running, 0) // 计数取实时值（gauge 冻结在 8 也无所谓）
  assert.equal(merged.waiting, 0)
  assert.equal(merged.cacheUsage, 0.4)
  assert.equal(merged.genTokensTotal, 700) // counter 仍来自 metrics
  assert.equal(merged.realtimeGenTokensTotal, 500)
  assert.equal(merged.prefillTokensTotal, 900)
  assert.equal(merged.genThroughput, 42)
  assert.equal(merged.backend, 'sglang')
  assert.equal(merged.hasConcurrency, true)
})

test('mergeLoads: 只有一路数据时直接返回那一路', () => {
  const metrics = { running: 3, waiting: 0, cacheUsage: null, hasConcurrency: true, backend: 'vllm' }
  const live = { running: 0, waiting: 0, cacheUsage: 0.2, hasConcurrency: true, backend: 'sglang' }
  assert.deepEqual(mergeLoads(null, metrics), metrics)
  assert.deepEqual(mergeLoads(live, null), live)
  assert.equal(mergeLoads(null, null), null)
})

test('sampleActivity: 1 token 级抖动不算活动（自己的 /health 生成、keepalive）', () => {
  const prev = { prefillTokens: 900, decodeTokens: 500, usedTokens: 3000, at: 0 }
  // 2s 只多了 1 个 token → 0.5 tok/s：低于阈值（正是 SGLang /health 默认生成 1 token 的量级）
  assert.equal(sampleActivity(
    { prefillTokensTotal: 900, realtimeGenTokensTotal: 501, usedTokensTotal: 3001 }, prev, 2000
  ).active, false)
  // 2s 多了 40 个 token → 20 tok/s：算在推理
  assert.equal(sampleActivity(
    { prefillTokensTotal: 900, realtimeGenTokensTotal: 540, usedTokensTotal: 3040 }, prev, 2000
  ).active, true)
  // 无 counter 时（/v1/loads）用 KV 占用增长率，同样要过阈值
  const gaugePrev = { prefillTokens: null, decodeTokens: null, usedTokens: 3000, at: 0 }
  assert.equal(sampleActivity({ usedTokensTotal: 3001 }, gaugePrev, 2000).active, false)
  assert.equal(sampleActivity({ usedTokensTotal: 9000 }, gaugePrev, 2000).active, true)
})

test('sampleActivity: prefill 速率远高于阈值时照旧判活动', () => {
  const prev = { prefillTokens: 1000, decodeTokens: 0, usedTokens: 0, at: 0 }
  const { active, prefillActive } = sampleActivity({ prefillTokensTotal: 9000, realtimeGenTokensTotal: 0 }, prev, 2000)
  assert.equal(active, true) // 4000 tok/s
  assert.equal(prefillActive, true)
})
