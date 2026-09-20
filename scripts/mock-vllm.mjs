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
  return CYCLE ? PHASES[phaseIndex] : { name: 'fixed', ...fixed }
}

// token counters：按请求速率随时间累计，供桌宠计算 tok/s（每并发约 42 tok/s 生成）
const GEN_PER_REQ = 42
const PROMPT_PER_REQ = 9
let genTotal = 120000
let promptTotal = 38000
let lastAdvance = Date.now()
function advanceTokens(running) {
  const now = Date.now()
  const dt = (now - lastAdvance) / 1000
  lastAdvance = now
  if (dt > 0 && running > 0) {
    genTotal += Math.round(running * GEN_PER_REQ * dt)
    promptTotal += Math.round(running * PROMPT_PER_REQ * dt)
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
    '# HELP sglang:token_usage The token usage.',
    '# TYPE sglang:token_usage gauge',
    `sglang:token_usage${SGLANG_LABELS} ${cache}`,
    '# HELP sglang:gen_throughput The generation throughput (token/s).',
    '# TYPE sglang:gen_throughput gauge',
    `sglang:gen_throughput${SGLANG_LABELS} ${running * GEN_PER_REQ}`,
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
    num_used_tokens: Math.round(cache * 8192),
    max_total_num_tokens: 8192,
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
  } else if (path === '/metrics') {
    if (NO_METRICS) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Not Found' }))
      return
    }
    advanceTokens(running)
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
    res.end(BACKEND === 'sglang' ? sglangMetrics({ running, waiting, cache }) : vllmMetrics({ running, waiting, cache }))
  } else if (path === '/v1/loads') {
    if (BACKEND !== 'sglang') {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(loadsBody({ running, waiting, cache }))
  } else {
    res.writeHead(404).end('not found')
  }
})

server.listen(PORT, () => {
  const metrics = NO_METRICS ? '/metrics(404)' : '/metrics'
  const loads = BACKEND === 'sglang' ? ' /v1/loads' : ''
  console.log(`[mock-vllm] http://127.0.0.1:${PORT}  backend=${BACKEND} (health /v1/models ${metrics}${loads})${CYCLE ? ' --cycle 每 8s 换档' : ''}`)
})