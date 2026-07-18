import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePrometheusMetrics,
  deriveState,
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

test('parsePrometheusMetrics: 忽略注释行并解析核心指标', () => {
  const m = parsePrometheusMetrics(SAMPLE)
  assert.equal(m.running, 3)
  assert.equal(m.waiting, 2)
  assert.equal(m.cacheUsage, 0.42)
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

test('parsePrometheusMetrics: 缺失指标返回 0，cacheUsage 为 null', () => {
  const m = parsePrometheusMetrics('vllm:prompt_tokens_total 9\n')
  assert.deepEqual(m, { running: 0, waiting: 0, cacheUsage: null })
})

test('parsePrometheusMetrics: 非法输入不抛异常', () => {
  assert.deepEqual(parsePrometheusMetrics(undefined), { running: 0, waiting: 0, cacheUsage: null })
  assert.deepEqual(parsePrometheusMetrics('not a metric at all'), { running: 0, waiting: 0, cacheUsage: null })
  // 不带边界匹配，避免误匹配 _total 后缀指标
  const m = parsePrometheusMetrics('vllm:num_requests_running_total 99\n')
  assert.equal(m.running, 0)
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
