#!/usr/bin/env node
/**
 * probe-load.mjs — 打印某推理服务地址的采集结果（排障用，不开 Electron、不写配置）。
 *
 * 用法：
 *   node scripts/probe-load.mjs http://127.0.0.1:30000             # backend=auto
 *   node scripts/probe-load.mjs http://127.0.0.1:30000 sglang      # 强制按 SGLang 策略采集
 *   node scripts/probe-load.mjs http://127.0.0.1:30000 vllm
 *
 * 输出每次采样的状态/引擎/来源/并发/KV/吞吐，并提示读不到负载数据的原因——
 * 用户反馈"明明在推理却显示空闲中"时，先跑这个定位（/metrics 是否可用）。
 */
import { PollerService } from '../src/main/poller-service.js'

const [apiBase, backend = 'auto', ...rest] = process.argv.slice(2)
if (!apiBase) {
  console.error('用法：node scripts/probe-load.mjs <apiBase> [auto|vllm|sglang]')
  process.exit(2)
}
const RAW = rest.includes('--raw')

const poller = new PollerService({
  getConfig: () => ({}),
  onStatus: () => {}
})
const config = {
  apiBase,
  backend,
  healthPath: '/health',
  metricsPath: '/metrics',
  pollIntervalMs: 1000
}

/** 与 poller 内部一致：先看 /metrics 是否认得，再看 /v1/loads 是否可用 */
async function peek(path) {
  try {
    const res = await fetch(apiBase.replace(/\/+$/, '') + path, { headers: { connection: 'close' } })
    if (!res.ok) return `HTTP ${res.status}`
    const text = await res.text()
    return RAW ? `HTTP 200（前 200 字）\n${text.slice(0, 200)}` : `HTTP 200（${text.length} 字节）`
  } catch (err) {
    return `请求失败：${err?.cause?.code || err?.message || err}`
  }
}

const snap = await poller._poll(config)
const second = await poller._poll(config)

const fmt = (s) => [
  `state=${s.state}`,
  `intensity=${s.intensity}`,
  `backend=${s.backend || '-'}`,
  `loadSource=${s.loadSource}`,
  `running=${s.running}`,
  `waiting=${s.waiting}`,
  `cacheUsage=${s.cacheUsage == null ? '-' : s.cacheUsage}`,
  `tokensPerSec=${s.tokensPerSec == null ? '-' : Math.round(s.tokensPerSec)}`,
  `latencyMs=${s.latencyMs}`,
  `hint=${s.hint || '-'}`,
  `error=${s.error || '-'}`
].join('  ')

console.log(`[probe] apiBase=${apiBase} backend=${backend}`)
console.log(`[probe] 第 1 次：${fmt(snap)}  （首次采样算不出 tok/s）`)
console.log(`[probe] 第 2 次：${fmt(second)}`)
console.log(`[probe] ---------------- 分项探测 ----------------`)
console.log(`[probe] ${config.healthPath}       → ${await peek(config.healthPath)}`)
console.log(`[probe] ${config.metricsPath}     → ${await peek(config.metricsPath)}`)
console.log(`[probe] /v1/loads?include=core → ${await peek('/v1/loads?include=core')}`)
if (snap.loadSource === 'none') {
  console.log('[probe] 读不到负载数据：SGLang 需启动加 --enable-metrics（或 ≥0.5.8 的 /v1/loads）；')
  console.log('[probe] vLLM 请确认 /metrics 可访问且未被 --api-key 拦住。')
}