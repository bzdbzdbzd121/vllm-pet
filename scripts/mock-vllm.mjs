#!/usr/bin/env node
/**
 * mock-vllm.mjs — 本地模拟推理服务（vLLM / SGLang），供联调与演示。
 *
 * 用法：
 *   node scripts/mock-vllm.mjs                          # vLLM 模式：恒定 3 running / 1 waiting
 *   node scripts/mock-vllm.mjs --port 9000
 *   node scripts/mock-vllm.mjs --running 20 --waiting 6 --cache 0.9
 *   node scripts/mock-vllm.mjs --cycle                  # 每 8 秒在 空闲→轻载→中载→重载 间循环
 *   node scripts/mock-vllm.mjs --backend sglang         # SGLang 指标名（sglang:*）+ /v1/loads
 *   node scripts/mock-vllm.mjs --backend sglang --no-metrics
 *                                                       # 模拟 SGLang 未加 --enable-metrics：
 *                                                       # /metrics 返回 404，桌宠应回退 /v1/loads
 *   node scripts/mock-vllm.mjs --backend sglang --stale-gauge 8
 *                                                       # 模拟 gauge 冻结：/metrics 永远报
 *                                                       # running=8，/v1/loads 报真实值 0
 *                                                       # （桌宠应以 /v1/loads 为准 → 空闲）
 *   node scripts/mock-vllm.mjs --prefill                # 模拟长 prompt 的 chunked prefill：
 *                                                       # 并发 gauge 恒为 0（SGLang 盲区），
 *                                                       # 但 prefill/KV 在增长 —— 桌宠应显示"预填充中"而非"空闲中"

 */
import http from 'node:http'

const args = process.argv.slice(2)
function argNum(name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}
function argStr(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : String(args[i + 1])
}
const PORT = argNum('port', 8765)
const CYCLE = args.includes('--cycle')
const BACKEND = argStr('backend', 'vllm') === 'sglang' ? 'sglang' : 'vllm'
/** 模拟 SGLang 没开 --enable-metrics：/metrics 不存在 */
const NO_METRICS = args.includes('--no-metrics')
/**
 * 模拟长 prompt 的 chunked prefill：SGLang 的并发 gauge 只统计 running_batch，
 * 正在 prefill 的请求被排除在外（见 status-core.js 注释），所以如实上报 running=waiting=0，
 * 但 prefill 计数与 KV 占用持续增长 —— 用来验证桌宠不会把它误判成"空闲"。
 */
const PREFILL = args.includes('--prefill')
const PREFILL_TPS = argNum('prefill-tps', 1200) // 每个 poll 间隔推进的 prefill token 量
/**
 * 模拟 SGLang 的"gauge 冻结"：调度器空闲后 num_running_reqs 会卡在最后一批的数值上
 * （上游 PR #26495 实测最长 30s，因为空闲路径的指标 flush 被 30s 节流）。
 * 此时 /metrics 一直报 --stale-gauge 给的旧值，而 /v1/loads（请求时现算）报真实值 0。
 */
const STALE_GAUGE = args.includes('--stale-gauge') ? argNum('stale-gauge', 8) : null

const PHASES = [
  { name: 'idle', running: 0, waiting: 0, cache: 0.28 },
  { name: 'light', running: 2, waiting: 0, cache: 0.45 },
  { name: 'medium', running: 7, waiting: 3, cache: 0.68 },
  { name: 'heavy', running: 24, waiting: 9, cache: 0.92 }
]
let phaseIndex = 0
const fixed = { running: argNum('running', 3), waiting: argNum('waiting', 1), cache: argNum('cache', 0.5) }

if (CYCLE) {
  setInterval(() => {
    phaseIndex = (phaseIndex + 1) % PHASES.length
    console.log(`[mock-vllm] 切换到 ${PHASES[phaseIndex].name}`)
  }, 8000)
}

function current() {
  const phase = CYCLE ? PHASES[phaseIndex] : { name: 'fixed', ...fixed }
  // SGLang 的盲区：正在 prefill 的请求不在 running_batch / waiting_queue 里
  return PREFILL ? { ...phase, running: 0, waiting: 0 } : phase
}

/** /metrics 侧（推送快照，可能冻结）：--stale-gauge 时永远报旧值；/v1/loads 侧用 current() */
function gauges() {
  const phase = current()
  return STALE_GAUGE == null ? phase : { ...phase, running: STALE_GAUGE, waiting: 0 }
}

// token counters——两组语义要区分（真实 SGLang 就是这样）：
//   realtime_tokens_total{mode=decode}：每次 decode 迭代都累加 → 桌宠用它算实时 tok/s
//   generation_tokens_total：SGLang 只在"请求结束"时结算 → 长请求进行中保持不变
//                            （vLLM 是每步累加，所以 vLLM 模式这两个 counter 同步增长）
const GEN_PER_REQ = 42
const PROMPT_PER_REQ = 9
const SETTLE_MS = 3000 // 模拟平均 3s 完成一批请求并结算累计 counter
let realtimeGenTotal = 900000
let realtimePrefillTotal = 260000
let usedTokens = 2600 // KV 池已占用 token 数（绝对值）
const MAX_TOTAL_TOKENS = 131072
let genTotal = 120000
let promptTotal = 38000
let unsettledGen = 0
let unsettledPrompt = 0
let lastAdvance = Date.now()
let lastSettle = Date.now()
function advanceTokens(running) {
  const now = Date.now()
  const dt = (now - lastAdvance) / 1000
  lastAdvance = now
  if (!(dt > 0)) return
  let gen = 0
  let prompt = 0
  if (PREFILL) {
    // 只有 prefill 在推进：没有 decode token，KV 池持续装 token
    prompt = Math.round(PREFILL_TPS * dt)
    usedTokens += prompt
  } else if (running > 0) {
    gen = Math.round(running * GEN_PER_REQ * dt)
    prompt = Math.round(running * PROMPT_PER_REQ * dt)
    usedTokens += gen + prompt
  } else {
    return
  }
  realtimeGenTotal += gen
  realtimePrefillTotal += prompt
  unsettledGen += gen
  unsettledPrompt += prompt
  // vLLM 每步都累加 generation_tokens_total；SGLang 只在请求结束时结算（这里用 SETTLE_MS 模拟）
  const shouldSettle = BACKEND !== 'sglang' || now - lastSettle >= SETTLE_MS
  if (shouldSettle) {
    genTotal += unsettledGen
    promptTotal += unsettledPrompt
    unsettledGen = 0
    unsettledPrompt = 0
    lastSettle = now
  }
}

const MODEL = 'mock-qwen3-32b'
/** SGLang 的 label 与 vLLM 不同：带 engine_type / tp_rank / pp_rank / moe_ep_rank */
const SGLANG_LABELS = `{model_name="${MODEL}",engine_type="unified",tp_rank="0",pp_rank="0",moe_ep_rank="0"}`

function vllmMetrics({ running, waiting, cache }) {
  return [
    '# HELP vllm:num_requests_running Number of requests currently running on GPU.',
    '# TYPE vllm:num_requests_running gauge',
    `vllm:num_requests_running{model_name="${MODEL}"} ${running}.0`,
    '# HELP vllm:num_requests_waiting Number of requests waiting to be scheduled.',
    '# TYPE vllm:num_requests_waiting gauge',
    `vllm:num_requests_waiting{model_name="${MODEL}"} ${waiting}.0`,
    '# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage. 1 means 100 percent usage.',
    '# TYPE vllm:gpu_cache_usage_perc gauge',
    `vllm:gpu_cache_usage_perc{model_name="${MODEL}"} ${cache}`,
    '# HELP vllm:prompt_tokens_total Number of prefill tokens processed.',
    '# TYPE vllm:prompt_tokens_total counter',
    `vllm:prompt_tokens_total{model_name="${MODEL}"} ${promptTotal}.0`,
    '# HELP vllm:generation_tokens_total Number of generation tokens processed.',
    '# TYPE vllm:generation_tokens_total counter',
    `vllm:generation_tokens_total{model_name="${MODEL}"} ${genTotal}.0`,
    ''
  ].join('\n')
}

function sglangMetrics({ running, waiting, cache }) {
  return [
    '# HELP sglang:num_running_reqs The number of running requests.',
    '# TYPE sglang:num_running_reqs gauge',
    `sglang:num_running_reqs${SGLANG_LABELS} ${running}.0`,
    '# HELP sglang:num_queue_reqs The number of requests in the waiting queue.',
    '# TYPE sglang:num_queue_reqs gauge',
    `sglang:num_queue_reqs${SGLANG_LABELS} ${waiting}.0`,
    '# HELP sglang:num_used_tokens The number of used tokens.',
    '# TYPE sglang:num_used_tokens gauge',
    `sglang:num_used_tokens${SGLANG_LABELS} ${usedTokens}.0`,
    '# HELP sglang:token_usage The token usage.',
    '# TYPE sglang:token_usage gauge',
    `sglang:token_usage${SGLANG_LABELS} ${cache}`,
    '# HELP sglang:gen_throughput The generation throughput (token/s).',
    '# TYPE sglang:gen_throughput gauge',
    `sglang:gen_throughput${SGLANG_LABELS} ${running * GEN_PER_REQ}`,
    '# HELP sglang:realtime_tokens_total The realtime number of tokens processed (per iteration).',
    '# TYPE sglang:realtime_tokens_total counter',
    `sglang:realtime_tokens_total${SGLANG_LABELS.replace('}', ',mode="prefill_compute"}')} ${realtimePrefillTotal}`,
    `sglang:realtime_tokens_total${SGLANG_LABELS.replace('}', ',mode="prefill_cache"}')} 0`,
    `sglang:realtime_tokens_total${SGLANG_LABELS.replace('}', ',mode="decode"}')} ${realtimeGenTotal}`,
    '# HELP sglang:prompt_tokens_total Number of prefill tokens processed.',
    '# TYPE sglang:prompt_tokens_total counter',
    `sglang:prompt_tokens_total${SGLANG_LABELS.replace('}', ',is_streaming="true"}')} ${promptTotal}.0`,
    '# HELP sglang:generation_tokens_total Number of generation tokens processed.',
    '# TYPE sglang:generation_tokens_total counter',
    `sglang:generation_tokens_total${SGLANG_LABELS.replace('}', ',is_streaming="true"}')} ${genTotal}.0`,
    ''
  ].join('\n')
}

/** SGLang /v1/loads 响应（只保留 core 段，与 ?include=core 一致） */
function loadsBody({ running, waiting, cache }) {
  const core = {
    dp_rank: 0,
    num_running_reqs: running,
    num_waiting_reqs: waiting,
    num_used_tokens: usedTokens,
    max_total_num_tokens: MAX_TOTAL_TOKENS,
    token_usage: cache,
    gen_throughput: running * GEN_PER_REQ,
    cache_hit_rate: 0.12,
    utilization: Math.min(1, (running + waiting) / 256),
    max_running_requests: 256
  }
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    version: '0.5.20-mock',
    dp_rank_count: 1,
    loads: [core],
    aggregate: {
      total_running_reqs: running,
      total_waiting_reqs: waiting,
      total_reqs: running + waiting,
      avg_token_usage: cache
    }
  })
}

const server = http.createServer((req, res) => {
  const { running, waiting, cache } = current()
  const path = req.url.split('?')[0]
  if (path === '/health') {
    res.writeHead(200).end('ok')
  } else if (path === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
  } else if (path === '/server_info' || path === '/get_server_info') {
    // 供 probe-load.mjs 打印服务版本（真实 SGLang 这两个接口都带 version 字段）
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model_path: MODEL, served_model_name: MODEL, version: '0.5.20-mock' }))
  } else if (path === '/metrics') {
    if (NO_METRICS) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Not Found' }))
      return
    }
    const g = gauges()
    // token/counter 只随**真实**工作量推进：gauge 冻结时它不能跟着动（真实 SGLang 空闲即不动）
    advanceTokens(running)
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
    res.end(BACKEND === 'sglang' ? sglangMetrics(g) : vllmMetrics(g))
  } else if (path === '/v1/loads') {
    if (BACKEND !== 'sglang') {
      res.writeHead(404).end('not found')
      return
    }
    advanceTokens(running)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(loadsBody({ running, waiting, cache }))
  } else {
    res.writeHead(404).end('not found')
  }
})

server.listen(PORT, () => {
  const metrics = NO_METRICS ? '/metrics(404)' : '/metrics'
  const loads = BACKEND === 'sglang' ? ' /v1/loads' : ''
  const prefill = PREFILL ? ' --prefill 模拟 chunked prefill（并发 gauge 恒为 0，prefill/KV 仍在增长）' : ''
  const stale = STALE_GAUGE != null ? ` --stale-gauge ${STALE_GAUGE} 模拟 gauge 冻结（/metrics 永远报旧值，/v1/loads 报真实值）` : ''
  console.log(`[mock-vllm] http://127.0.0.1:${PORT}  backend=${BACKEND} (health /v1/models ${metrics}${loads})${CYCLE ? ' --cycle 每 8s 换档' : ''}${prefill}${stale}`)
})