/**
 * status-core.js — vLLM 服务状态解析与推导（纯函数，零依赖，浏览器/Node 通用）
 *
 * vLLM `/metrics` 暴露的 Prometheus 关键指标：
 *   vllm:num_requests_running   — 正在推理的请求数（带 label 时有多行）
 *   vllm:num_requests_waiting   — 排队等待的请求数
 *   vllm:gpu_cache_usage_perc   — KV cache 使用率 0~1
 */

export const DEFAULT_THRESHOLDS = Object.freeze({
  light: 1, // running+waiting >= 1  → 轻载
  medium: 4, //                  >= 4  → 中载
  heavy: 16, //                  >= 16 → 重载
  cacheHeavy: 0.85 // KV cache 占用 >= 85% 也视为重载
})

/**
 * 解析 Prometheus 文本。永不抛异常；文本非法时返回全零对象。
 * @param {string} text
 * @returns {{ running: number, waiting: number, cacheUsage: number|null }}
 */
export function parsePrometheusMetrics(text) {
  const result = { running: 0, waiting: 0, cacheUsage: null }
  if (typeof text !== 'string' || text.length === 0) return result

  const gauges = {
    'vllm:num_requests_running': 'running',
    'vllm:num_requests_waiting': 'waiting'
  }
  const CACHE = 'vllm:gpu_cache_usage_perc'

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    for (const [metric, field] of Object.entries(gauges)) {
      const value = matchMetricValue(line, metric)
      if (value !== null) result[field] += value
    }
    const cache = matchMetricValue(line, CACHE)
    if (cache !== null) result.cacheUsage = cache
  }
  return result
}

/**
 * 匹配 `metric_name{labels} value` 或 `metric_name value` 行。
 * @returns {number|null}
 */
function matchMetricValue(line, metric) {
  if (!line.startsWith(metric)) return null
  const rest = line.slice(metric.length)
  // 避免把 vllm:num_requests_running_total 之类当成目标指标
  if (!rest.startsWith('{') && !rest.startsWith(' ') && !rest.startsWith('\t')) return null
  const valueStr = rest.replace(/^\{[^}]*\}/, '').trim().split(/\s+/)[0]
  const value = Number.parseFloat(valueStr)
  return Number.isFinite(value) ? value : null
}

/**
 * 由健康检查 + 指标推导桌宠状态。
 * @param {{ healthOk: boolean, metrics: object|null, prevState?: string }} input
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @returns {{ state: 'offline'|'idle'|'busy', intensity: 0|1|2|3 }}
 */
export function deriveState({ healthOk, metrics } = {}, thresholds) {
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
  return { state: 'idle', intensity: 0 }
}
