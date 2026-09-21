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

const BASE = apiBase.replace(/\/+$/, '')
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

/** 推理服务版本（/server_info 新接口优先，回退 /get_server_info）——排障时先看这个 */
async function serverVersion() {
  for (const path of ['/server_info', '/get_server_info']) {
    try {
      const res = await fetch(BASE + path, { headers: { connection: 'close' } })
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      const version = data?.version || data?.sglang_version
      const model = data?.model_path || data?.served_model_name
      if (version) return `${version}${model ? `（${model}）` : ''} 来自 ${path}`
    } catch { /* 换下一个接口 */ }
  }
  return '未知（/server_info 与 /get_server_info 都不可用）'
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
// 两次采样相隔 1.2s：counter 差值算出的 tok/s 才有意义（紧贴着采会得到 0 或夸张值）
await new Promise((resolve) => setTimeout(resolve, 1200))
const second = await poller._poll(config)

const fmt = (s) => [
  `state=${s.state}`,
  `intensity=${s.intensity}`,
  `backend=${s.backend || '-'}`,
  `loadSource=${s.loadSource}`,
  `running=${s.running}`,
  `waiting=${s.waiting}`,
  `prefillActive=${s.prefillActive}`,
  `cacheUsage=${s.cacheUsage == null ? '-' : s.cacheUsage}`,
  `tokensPerSec=${s.tokensPerSec == null ? '-' : Math.round(s.tokensPerSec)}`,
  `latencyMs=${s.latencyMs}`,
  `hint=${s.hint || '-'}`,
  `error=${s.error || '-'}`
].join('  ')

console.log(`[probe] apiBase=${BASE} backend=${backend}`)
console.log(`[probe] 服务版本：${await serverVersion()}`)
console.log(`[probe] 第 1 次：${fmt(snap)}  （首次采样只能用服务自报吞吐）`)
console.log(`[probe] 第 2 次：${fmt(second)}`)
console.log(`[probe] ---------------- 分项探测 ----------------`)
console.log(`[probe] ${config.healthPath}       → ${await peek(config.healthPath)}`)
console.log(`[probe] ${config.metricsPath}     → ${await peek(config.metricsPath)}`)
console.log(`[probe] /v1/loads?include=core → ${await peek('/v1/loads?include=core')}`)
if (snap.loadSource === 'none') {
  console.log('[probe] 读不到负载数据：SGLang 需启动加 --enable-metrics（或 ≥0.5.8 的 /v1/loads）；')
  console.log('[probe] vLLM 请确认 /metrics 可访问且未被 --api-key 拦住。')
}
if (second.state === 'busy' && !(second.tokensPerSec > 0) && !second.prefillActive) {
  console.log('[probe] 忙但 tok/s 为 0：SGLang 的 generation_tokens_total 只在请求结束时累加，')
  console.log('[probe] 应有 sglang:realtime_tokens_total{mode="decode"} 或 sglang:gen_throughput 兜底（见上方分项探测）。')
}
if (second.prefillActive) {
  console.log('[probe] prefillActive=true：正在 prefill（SGLang 此时并发为 0 属正常），')
  console.log('[probe] 桌宠会显示"推理中"（不带计数）而不是"空闲中"。')
}
if (second.prefillActive && second.state === 'idle' && second.loadSource === 'metrics') {
  console.log('[probe] ⚠️ 正在 prefill 但判成了 idle：说明既没有实时 counter 也没有 /v1/loads，')
  console.log('[probe]    建议 SGLang >= 0.5.8（提供 /v1/loads）或启动加 --enable-metrics。')
}
if (second.loadSource === 'metrics' && second.backend === 'sglang') {
  console.log('[probe] ⚠️ 并发数来自 /metrics gauge（推送快照）：SGLang 空闲后它会冻结在最后一批的')
  console.log('[probe]    数值上（上游 PR #26495，实测最长 30s），可能让桌宠多报一段"忙碌"。')
  console.log('[probe]    升级到 SGLang >= 0.5.8 后会优先用 /v1/loads 的实时值（loadSource=loads）。')
}