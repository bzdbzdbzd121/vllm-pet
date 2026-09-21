/**
 * status-core.js — 推理服务（vLLM / SGLang）状态解析与推导（纯函数，零依赖，浏览器/Node 通用）
 *
 * 两族指标名靠前缀区分，自动识别、互不冲突：
 *
 *   vLLM `/metrics`
 *     vllm:num_requests_running    — 正在推理的请求数（gauge）
 *     vllm:num_requests_waiting    — 排队等待的请求数（gauge）
 *     vllm:gpu_cache_usage_perc    — KV cache 使用率 0~1（≤ v0.26）
 *     vllm:kv_cache_usage_perc     — KV cache 使用率 0~1（v0.27+ 改名，两个名字都认）
 *     vllm:prompt_tokens_total     — 累计输入 token（counter）
 *     vllm:generation_tokens_total — 累计生成 token（counter，两次采样求差即 tok/s）
 *
 *   SGLang `/metrics`（需启动加 --enable-metrics，默认关闭）
 *     sglang:num_running_reqs      — 正在推理的请求数（gauge）
 *     sglang:num_queue_reqs        — 等待队列请求数（gauge）
 *     sglang:token_usage           — token 池（KV cache）使用率 0~1（gauge）
 *     sglang:realtime_tokens_total — 每次迭代（iteration）累加的 token，带 mode 标签：
 *                                    decode 是生成 token（实时 tok/s 靠它）；
 *                                    prefill_compute / prefill_cache 是 prefill 进度
 *     sglang:num_used_tokens       — KV 池已占用 token 数（绝对值，增长说明在装 token）
 *     sglang:generation_tokens_total — ⚠️ 只在**请求结束时**才累加（observe_one_finished_request），
 *                                    长请求进行中差值恒为 0，不能用来算实时吞吐
 *     sglang:gen_throughput        — 服务自报生成吞吐 tok/s（gauge，counter 算不出时兜底）
 *
 * ⚠️ SGLang 的 /metrics gauge 是**推送快照**，空闲后会冻结：`num_running_reqs` 在调度器
 *   转为空闲后会被 30s 的 flush 节流卡住（上游 PR #26495 实测 24 卡了整整 30s），用它判
 *   "是否还在忙"会多报一段尾巴 → 计数优先取请求时现算的 `/v1/loads`（见 mergeLoads）。
 *   counter（tok/s / 活动信号）仍取 /metrics。
 *
 * ⚠️ SGLang 的并发 gauge 看不到正在 prefill 的请求：
 *   `num_running_reqs` = len(scheduler.running_batch.reqs)，而正在 prefill（含 chunked prefill）
 *   的请求被有意排除在 running_batch 之外（scheduler.get_next_batch_to_run() 里
 *   `chunked_req_to_exclude.add(self.chunked_req)` 注释："Move the chunked request out of
 *   the batch so that we can merge only finished requests to running_batch"），
 *   也不在 waiting_queue（它存在 self.chunked_req / last_batch 里）——
 *   于是长 prompt 的 prefill 阶段 running=waiting=0，只看这两个 gauge 会误判为"空闲"。
 *   `/v1/loads` 的 num_running_reqs 同样是 len(running_batch.reqs)，同样有盲区。
 *   因此靠 sampleActivity() 的"在增长"信号把这段时间认出来。
 *
 * 同名指标带多个 label（多 DP/TP rank、多 model、is_streaming…）时求和成总量；
 * 唯独 SGLang 的 priority 维度是"总量行 + 分档行"两层结构（priority="" 为总量，
 * priority="0"/"1"… 为分档），只取总量行，避免重复计数。
 * 比率类指标（KV cache 使用率）跨 label 取最大值：任一 rank 逼近上限都算重载。
 */

export const DEFAULT_THRESHOLDS = Object.freeze({
  light: 1, // running+waiting >= 1  → 轻载
  medium: 4, //                  >= 4  → 中载
  heavy: 16, //                  >= 16 → 重载
  cacheHeavy: 0.85 // KV cache 占用 >= 85% 也视为重载
})

/** 支持的后端类型（配置项 backend） */
export const BACKENDS = Object.freeze(['auto', 'vllm', 'sglang'])

/**
 * 活动判定所需的最小推进速率（token/s）。
 * 用来滤掉 1 token 级的抖动：SGLang 的 `/health` 默认会真生成 1 个 token
 * （`SGLANG_ENABLE_HEALTH_ENDPOINT_GENERATION` 默认 True），每 2s 探一次就是 0.5 tok/s——
 * 这种量级不能算"在推理"，否则监测工具会把自己的健康检查喂成永久的忙碌状态。
 * 真正的 prefill（chunked prefill 每轮上千 token）与正常 decode 都远高于它。
 */
export const ACTIVITY_MIN_TOKENS_PER_SEC = 5

/**
 * 指标名 → 字段映射。
 * kind: 'sum'     跨 label 求和（并发数、吞吐）
 *       'max'     跨 label 取最大（比率类，不该相加）
 *       'counter' 累计值，跨 label 求和，缺失时为 null
 * modes: 同一个指标名按 label 拆到不同字段（如 SGLang realtime_tokens_total 的 mode）
 */
const METRIC_SPECS = new Map([
  ['vllm:num_requests_running', { field: 'running', kind: 'sum', backend: 'vllm' }],
  ['vllm:num_requests_waiting', { field: 'waiting', kind: 'sum', backend: 'vllm' }],
  ['vllm:gpu_cache_usage_perc', { field: 'cacheUsage', kind: 'max', backend: 'vllm' }],
  ['vllm:kv_cache_usage_perc', { field: 'cacheUsage', kind: 'max', backend: 'vllm' }],
  ['vllm:prompt_tokens_total', { field: 'promptTokensTotal', kind: 'counter', backend: 'vllm' }],
  ['vllm:generation_tokens_total', { field: 'genTokensTotal', kind: 'counter', backend: 'vllm' }],
  ['sglang:num_running_reqs', { field: 'running', kind: 'sum', backend: 'sglang' }],
  ['sglang:num_queue_reqs', { field: 'waiting', kind: 'sum', backend: 'sglang' }],
  ['sglang:num_used_tokens', { field: 'usedTokensTotal', kind: 'sum', backend: 'sglang' }],
  ['sglang:token_usage', { field: 'cacheUsage', kind: 'max', backend: 'sglang' }],
  ['sglang:prompt_tokens_total', { field: 'promptTokensTotal', kind: 'counter', backend: 'sglang' }],
  ['sglang:generation_tokens_total', { field: 'genTokensTotal', kind: 'counter', backend: 'sglang' }],
  ['sglang:gen_throughput', { field: 'genThroughput', kind: 'sum', backend: 'sglang' }],
  // 只有 decode 模式是"输出 token"；prefill_compute/prefill_cache 合到同一个字段，
  // 它们是 prefill 进度信号（sampleActivity 靠它识别 prefill 阶段的"隐形"请求）
  ['sglang:realtime_tokens_total', {
    modes: { decode: 'realtimeGenTokensTotal', prefill_compute: 'prefillTokensTotal', prefill_cache: 'prefillTokensTotal' },
    kind: 'counter',
    backend: 'sglang'
  }]
])

/** 空负载对象（解析不到任何指标时的形状） */
function emptyLoad() {
  return {
    backend: null, // 认出指标的引擎（'vllm' | 'sglang'）；null = 一条指标都没认出来
    hasConcurrency: false, // 是否读到并发（running）指标 —— 没有它就无法判断忙/闲
    running: 0,
    waiting: 0,
    cacheUsage: null,
    promptTokensTotal: null,
    genTokensTotal: null,
    realtimeGenTokensTotal: null, // SGLang 每次迭代累加的 decode token（实时吞吐用）
    prefillTokensTotal: null, // SGLang 每次迭代累加的 prefill token（prefill 活动信号）
    usedTokensTotal: null, // KV 池已占用 token 数（无 counter 时的活动信号）
    genThroughput: null
  }
}

/**
 * 解析 Prometheus 文本。永不抛异常；文本非法时返回全零对象。
 * @param {string} text
 * @returns {{ backend: 'vllm'|'sglang'|null, hasConcurrency: boolean, running: number,
 *             waiting: number, cacheUsage: number|null, promptTokensTotal: number|null,
 *             genTokensTotal: number|null, realtimeGenTokensTotal: number|null,
 *             prefillTokensTotal: number|null, usedTokensTotal: number|null,
 *             genThroughput: number|null }}
 */
export function parsePrometheusMetrics(text) {
  const result = emptyLoad()
  if (typeof text !== 'string' || text.length === 0) return result

  /** @type {Map<string, {kind: string, total: number, part: number, hasTotal: boolean, max: number|null}>} */
  const buckets = new Map()
  for (const rawLine of text.split('\n')) {
    const sample = readSample(rawLine)
    if (!sample) continue
    const spec = METRIC_SPECS.get(sample.name)
    if (!spec) continue
    // modes：同名指标按 label（如 SGLang 的 mode）拆到不同字段，不关心的取值直接跳过
    const field = spec.modes ? spec.modes[sample.mode] : spec.field
    if (!field) continue

    let bucket = buckets.get(field)
    if (!bucket) {
      bucket = { kind: spec.kind, total: 0, part: 0, hasTotal: false, max: null }
      buckets.set(field, bucket)
    }
    if (spec.kind === 'sum') {
      // SGLang 开 priority 调度时：priority="" 是总量行，priority="0"… 是分档行，只取其一
      if (sample.priority) bucket.part += sample.value
      else {
        bucket.total += sample.value
        bucket.hasTotal = true
      }
    } else if (spec.kind === 'max') {
      bucket.max = bucket.max === null ? sample.value : Math.max(bucket.max, sample.value)
    } else {
      bucket.total += sample.value
      bucket.hasTotal = true
    }
    if (!result.backend) result.backend = spec.backend
  }

  result.hasConcurrency = buckets.has('running')
  for (const [field, bucket] of buckets) {
    if (bucket.kind === 'max') result[field] = bucket.max
    else if (bucket.kind === 'counter') result[field] = bucket.hasTotal ? bucket.total : null
    else result[field] = bucket.hasTotal ? bucket.total : bucket.part
  }
  return result
}

/**
 * 解析 SGLang `/v1/loads?include=core`（v0.5.8+）响应；
 * 兼容 `/get_load`（v0.5.20+ 的同结构记录数组）。
 * 用于 SGLang 未开 `--enable-metrics` 时兜底取负载。
 * @param {any} data JSON 响应体
 * @returns {ReturnType<typeof emptyLoad>|null} 无法解析时返回 null
 */
export function parseLoadsResponse(data) {
  const loads = Array.isArray(data?.loads) ? data.loads : Array.isArray(data) ? data : null
  if (!loads || loads.length === 0) return null

  let running = 0
  let waiting = 0
  let cacheUsage = null
  let genThroughput = null
  let usedTokensTotal = null
  for (const item of loads) {
    if (!item || typeof item !== 'object') continue
    const waitingReqs = toNumber(item.num_waiting_reqs)
    waiting += waitingReqs
    // /v1/loads 给 num_running_reqs；旧 /get_load 只给 num_reqs（= running + waiting）
    const runningReqs = item.num_running_reqs != null
      ? toNumber(item.num_running_reqs)
      : toNumber(item.num_reqs) - waitingReqs
    running += Math.max(0, runningReqs)
    if (item.token_usage != null) {
      cacheUsage = cacheUsage === null ? toNumber(item.token_usage) : Math.max(cacheUsage, toNumber(item.token_usage))
    }
    if (item.gen_throughput != null) genThroughput = (genThroughput ?? 0) + toNumber(item.gen_throughput)
    if (item.num_used_tokens != null) usedTokensTotal = (usedTokensTotal ?? 0) + toNumber(item.num_used_tokens)
  }
  return {
    ...emptyLoad(),
    backend: 'sglang',
    hasConcurrency: true,
    running,
    waiting,
    cacheUsage,
    genThroughput,
    usedTokensTotal
  }
}

/**
 * 由前后两次 counter 采样计算速率（tok/s）。
 * @param {{ value: number, at: number }|null} prev 上一次采样（at 为毫秒时间戳）
 * @param {{ value: number, at: number }|null} curr 本次采样
 * @returns {number|null} 无法计算时返回 null（缺样本 / 间隔非正 / counter 因服务重启清零）
 */
export function tokenRate(prev, curr) {
  if (!prev || !curr) return null
  const dt = (curr.at - prev.at) / 1000
  if (!(dt > 0)) return null
  const delta = curr.value - prev.value
  if (delta < 0) return null // counter reset：服务重启过，丢弃本次样本
  return delta / dt
}

/**
 * 生成吞吐（tok/s）采样：把"该用哪个 counter"的策略收在一处，主进程与预览页共用。
 *
 * 优先级：
 *   1. SGLang `realtime_tokens_total{mode="decode"}`——每次迭代累加，实时且准确
 *   2. 累计 counter（vLLM `generation_tokens_total` / SGLang 同名）两次采样求差
 *   3. 服务自报 `gen_throughput`（SGLang 的累计 counter 只在请求结束时跳一下，
 *      长请求进行中差值恒为 0，靠自报吞吐兼顾“刚起步/prefill 阶段”）
 *
 * @param {object|null} load 本次负载（parsePrometheusMetrics / parseLoadsResponse 的结果）
 * @param {{ value: number, at: number, source: string }|null} prev 上一次采样
 * @param {number} [at] 本次采样时间戳（毫秒）
 * @returns {{ tokensPerSec: number|null, sample: { value: number, at: number, source: string }|null }}
 */
export function sampleGenerationRate(load, prev = null, at = Date.now()) {
  const counter = load?.realtimeGenTokensTotal != null
    ? { source: 'realtime', value: load.realtimeGenTokensTotal }
    : load?.genTokensTotal != null
      ? { source: 'total', value: load.genTokensTotal }
      : null
  const gauge = load?.genThroughput ?? null
  if (!counter) return { tokensPerSec: gauge, sample: null }

  // counter 源变了（指标消失/服务重启）就丢弃旧样本，避免跨源求差得到垃圾值
  const rate = prev && prev.source === counter.source ? tokenRate(prev, { value: counter.value, at }) : null
  let tokensPerSec = rate
  if (!(tokensPerSec > 0) && gauge != null) tokensPerSec = gauge
  return { tokensPerSec, sample: { value: counter.value, at, source: counter.source } }
}

/**
 * 活动采样：识别"gauge 看不到、但确实在干活"的时段（主要是 SGLang 的 prefill 阶段）。
 *
 * 用"在增长"而不是"大于 0"：counter/gauge 只要两次采样间变大，就说明服务在这段时间里
 * 真的推进了工作；都平了就说明真的闲下来了。
 *
 * 优先级（都可用时任一为真即 active）：
 *   1. prefillTokensTotal（realtime_tokens_total 的 prefill_* 模式）——每次 prefill 迭代都累加，
 *      专治 chunked prefill 期间 running=waiting=0 的盲区
 *   2. realtimeGenTokensTotal（decode 模式）——SGLang 的并发 gauge 默认每 decode_log_interval
 *      （默认 40）个迭代才刷新一次，短短几十 token 的生成可能整段都看不到，靠它补上
 *   3. usedTokensTotal（KV 池占用）——没有 counter 时（未开 --enable-metrics 走 /v1/loads）
 *      唯一可用信号；不做为主信号是因为它是 gauge，多 rank label 集合变化也会跳变
 *
 * 判定用**速率**而不是"涨了就算"：增量需 ≥ `ACTIVITY_MIN_TOKENS_PER_SEC`（见该常量注释，
 * 滤掉健康检查/keepalive 这种 1 token 级报动）。
 *
 * @param {object|null} load 本次负载
 * @param {{ prefillTokens: number|null, decodeTokens: number|null, usedTokens: number|null, at: number }|null} prev 上次采样
 * @param {number} [at] 本次采样时间戳（毫秒）
 * @returns {{ active: boolean, prefillActive: boolean,
 *             sample: { prefillTokens: number|null, decodeTokens: number|null, usedTokens: number|null, at: number } }}
 */
export function sampleActivity(load, prev = null, at = Date.now()) {
  const prefillTokens = load?.prefillTokensTotal ?? null
  const decodeTokens = load?.realtimeGenTokensTotal ?? null
  const usedTokens = load?.usedTokensTotal ?? null
  const sample = { prefillTokens, decodeTokens, usedTokens, at }
  if (!prev || at <= prev.at) return { active: false, prefillActive: false, sample }

  const dt = (at - prev.at) / 1000 // 秒
  const rate = (curr, before) =>
    curr != null && before != null && curr > before ? (curr - before) / dt : 0

  const prefillActive = rate(prefillTokens, prev.prefillTokens) >= ACTIVITY_MIN_TOKENS_PER_SEC
  const hasCounters = prefillTokens != null || decodeTokens != null
  const active = hasCounters
    ? prefillActive || rate(decodeTokens, prev.decodeTokens) >= ACTIVITY_MIN_TOKENS_PER_SEC
    : rate(usedTokens, prev.usedTokens) >= ACTIVITY_MIN_TOKENS_PER_SEC
  return { active, prefillActive, sample }
}

/**
 * 合并两路采集结果：/v1/loads（实时计数）+ /metrics（counter 与吞吐）。
 *
 * 计数（running/waiting/cacheUsage）优先用 /v1/loads——它是请求时现算的实时值；
 * /metrics 的 gauge 是推送快照，SGLang 空闲后会冻结在最后一批的数值上（上游 PR #26495）。
 * counter（genTokensTotal / realtimeGenTokensTotal / prefillTokensTotal）与 genThroughput
 * 仍用 /metrics。任一路为 null 时返回另一路。
 *
 * @param {ReturnType<typeof emptyLoad>|null} live parseLoadsResponse 的结果
 * @param {ReturnType<typeof emptyLoad>|null} metrics parsePrometheusMetrics 的结果
 * @returns {ReturnType<typeof emptyLoad>|null}
 */
export function mergeLoads(live, metrics) {
  if (!live) return metrics
  if (!metrics) return live
  return {
    ...metrics, // counter / genThroughput：metrics 是唯一来源
    backend: live.backend ?? metrics.backend,
    hasConcurrency: true,
    running: live.running,
    waiting: live.waiting,
    cacheUsage: live.cacheUsage ?? metrics.cacheUsage,
    usedTokensTotal: live.usedTokensTotal ?? metrics.usedTokensTotal,
    genThroughput: metrics.genThroughput ?? live.genThroughput
  }
}

/**
 * 读取一行样本 `metric_name{labels} value`。不匹配返回 null。
 * 精确匹配指标名（而不是前缀），天然避免把 `*_total`/`*_by_reason` 之类当成目标指标。
 * @returns {{ name: string, priority: string|null, mode: string|null, value: number }|null}
 */
function readSample(line) {
  // 去首尾空白（兼容 CRLF 与行首缩进；注释行也会被下面精确匹配挡掉）
  const trimmed = line.trim()
  const braceIdx = trimmed.indexOf('{')
  const spaceIdx = trimmed.search(/[ \t]/)
  let nameEnd = -1
  if (braceIdx !== -1 && (spaceIdx === -1 || braceIdx < spaceIdx)) nameEnd = braceIdx
  else if (spaceIdx !== -1) nameEnd = spaceIdx
  if (nameEnd <= 0) return null

  const name = trimmed.slice(0, nameEnd)
  let priority = null
  let mode = null
  let rest = trimmed.slice(nameEnd)
  if (rest.startsWith('{')) {
    const end = rest.indexOf('}')
    if (end === -1) return null
    const block = rest.slice(1, end)
    priority = readLabel(block, 'priority')
    mode = readLabel(block, 'mode')
    rest = rest.slice(end + 1)
  }
  const valueStr = rest.trim().split(/\s+/)[0]
  const value = Number.parseFloat(valueStr)
  if (!Number.isFinite(value)) return null
  return { name, priority, mode, value }
}

/** 从 label 块里取一个标签值（标签名需完整匹配，避免撞上 xxx_priority） */
function readLabel(block, key) {
  const needle = `${key}="`
  let idx = block.indexOf(needle)
  while (idx !== -1) {
    const start = idx + needle.length
    const end = block.indexOf('"', start)
    if ((idx === 0 || block[idx - 1] === ',') && end !== -1) return block.slice(start, end)
    idx = block.indexOf(needle, idx + 1)
  }
  return null
}

function toNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 由健康检查 + 负载指标推导桌宠状态。
 * @param {{ healthOk: boolean, metrics: object|null, active?: boolean, prevState?: string }} input
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @returns {{ state: 'offline'|'idle'|'busy', intensity: 0|1|2|3 }}
 */
export function deriveState({ healthOk, metrics, active } = {}, thresholds) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) }
  if (!healthOk) return { state: 'offline', intensity: 0 }
  if (!metrics) return { state: 'idle', intensity: 0 } // 老版本无 /metrics：降级为仅存活检测

  const total = (metrics.running || 0) + (metrics.waiting || 0)
  const cache = metrics.cacheUsage
  if (total >= t.heavy || (cache != null && cache >= t.cacheHeavy)) {
    return { state: 'busy', intensity: 3 }
  }
  if (total >= t.medium) return { state: 'busy', intensity: 2 }
  if (total >= t.light) return { state: 'busy', intensity: 1 }
  // 并发 gauge 读不到但服务在推进（典型：SGLang 的 prefill 阶段）——至少轻载，别误报"空闲"
  if (active) return { state: 'busy', intensity: 1 }
  return { state: 'idle', intensity: 0 }
}