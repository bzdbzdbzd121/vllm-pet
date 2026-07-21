#!/usr/bin/env node
/**
 * mock-vllm.mjs — 本地模拟 vLLM 服务，供联调与演示。
 *
 * 用法：
 *   node scripts/mock-vllm.mjs                      # 恒定 3 running / 1 waiting
 *   node scripts/mock-vllm.mjs --port 9000
 *   node scripts/mock-vllm.mjs --running 20 --waiting 6 --cache 0.9
 *   node scripts/mock-vllm.mjs --cycle              # 每 8 秒在 空闲→轻载→中载→重载 间循环
 */
import http from 'node:http'

const args = process.argv.slice(2)
function argNum(name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}
const PORT = argNum('port', 8765)
const CYCLE = args.includes('--cycle')

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

const server = http.createServer((req, res) => {
  const { running, waiting, cache } = current()
  if (req.url === '/health') {
    res.writeHead(200).end('ok')
  } else if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-qwen3-32b', object: 'model' }] }))
  } else if (req.url === '/metrics') {
    advanceTokens(running)
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
    res.end([
      '# HELP vllm:num_requests_running Number of requests currently running on GPU.',
      '# TYPE vllm:num_requests_running gauge',
      `vllm:num_requests_running{model_name="mock-qwen3-32b"} ${running}.0`,
      '# HELP vllm:num_requests_waiting Number of requests waiting to be scheduled.',
      '# TYPE vllm:num_requests_waiting gauge',
      `vllm:num_requests_waiting{model_name="mock-qwen3-32b"} ${waiting}.0`,
      '# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage. 1 means 100 percent usage.',
      '# TYPE vllm:gpu_cache_usage_perc gauge',
      `vllm:gpu_cache_usage_perc{model_name="mock-qwen3-32b"} ${cache}`,
      '# HELP vllm:prompt_tokens_total Number of prefill tokens processed.',
      '# TYPE vllm:prompt_tokens_total counter',
      `vllm:prompt_tokens_total{model_name="mock-qwen3-32b"} ${promptTotal}.0`,
      '# HELP vllm:generation_tokens_total Number of generation tokens processed.',
      '# TYPE vllm:generation_tokens_total counter',
      `vllm:generation_tokens_total{model_name="mock-qwen3-32b"} ${genTotal}.0`,
      ''
    ].join('\n'))
  } else {
    res.writeHead(404).end('not found')
  }
})

server.listen(PORT, () => {
  console.log(`[mock-vllm] http://127.0.0.1:${PORT}  (health /v1/models /metrics)${CYCLE ? ' --cycle 每 8s 换档' : ''}`)
})
