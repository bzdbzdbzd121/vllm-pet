/**
 * settings-panel.js — 设置面板（独立设置窗口 / 预览页内嵌 共用）
 *
 * 可配置：服务连接、状态切换条件（各档并发/KV 阈值）、动画映射（每档用哪个动画）、
 * 皮肤、体型缩放、窗口置顶/穿透。
 */
import { listAvailableSkins } from '../skins/skin-loader.js'

const ANIMATION_OPTIONS = [
  { value: 'busy-1', label: '💨 轻快（天线脉冲）' },
  { value: 'busy-2', label: '💦 中速（汗滴 + 蒸汽）' },
  { value: 'busy-3', label: '🔥 狂热（抖动 + 全特效）' }
]

export class SettingsPanel {
  /**
   * @param {{
   *   provider: { getConfig(): Promise<object>, saveConfig(p: object): Promise<object> },
   *   bridge?: object|null,        // window.vllmPet（浏览器预览时为 null）
   *   pageMode?: boolean,          // true = 独立设置窗口/内嵌页（保存后走 onClose 关闭）
   *   onSaved?: (config: object) => void,
   *   onClose?: () => void
   * }} opts
   */
  constructor({ provider, bridge = null, pageMode = false, onSaved, onClose }) {
    this.provider = provider
    this.bridge = bridge
    this.pageMode = pageMode
    this.onSaved = onSaved || (() => {})
    this.onClose = onClose || (() => {})
    this.el = null
  }

  get isOpen() {
    return !!this.el
  }

  async open(anchorEl) {
    if (this.el) return
    const config = await this.provider.getConfig()
    const skins = await listAvailableSkins(this.bridge)
    const t = config.thresholds || {}
    const sm = config.stateMap || {}

    const animSelect = (name, current) => `
      <select name="${name}">
        ${ANIMATION_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>`

    const el = document.createElement('div')
    el.className = 'pet-settings'
    el.innerHTML = `
      <h3>⚙️ 小V 设置</h3>

      <div class="section">🔌 服务连接</div>
      <label>vLLM 服务地址</label>
      <input type="text" name="apiBase" placeholder="http://127.0.0.1:8000" value="${esc(config.apiBase)}">
      <label>API Key（可选）</label>
      <input type="password" name="apiKey" placeholder="留空则不携带鉴权头" value="${esc(config.apiKey)}">
      <label>轮询间隔 (ms)</label>
      <input type="number" name="pollIntervalMs" min="500" max="60000" step="100" value="${config.pollIntervalMs}">

      <div class="section">📊 状态切换条件<span class="section-note">并发 = 推理中 + 排队请求数</span></div>
      <div class="row">
        <div><label>轻载：并发 ≥</label><input type="number" name="tLight" min="1" value="${t.light ?? 1}"></div>
        <div><label>中载：并发 ≥</label><input type="number" name="tMedium" min="1" value="${t.medium ?? 4}"></div>
      </div>
      <div class="row">
        <div><label>重载：并发 ≥</label><input type="number" name="tHeavy" min="1" value="${t.heavy ?? 16}"></div>
        <div><label>或 KV cache ≥</label><input type="number" name="tCache" min="0.1" max="1" step="0.05" value="${t.cacheHeavy ?? 0.85}"></div>
      </div>

      <div class="section">🎬 动画映射<span class="section-note">每个负载档位播放哪种动画</span></div>
      <label>轻载时</label>
      ${animSelect('animLight', sm.light ?? 'busy-1')}
      <label>中载时</label>
      ${animSelect('animMedium', sm.medium ?? 'busy-2')}
      <label>重载时</label>
      ${animSelect('animHeavy', sm.heavy ?? 'busy-3')}

      <div class="section">🎨 外观与窗口</div>
      <div class="row">
        <div>
          <label>皮肤</label>
          <select name="skin">
            ${skins.map((s) => `<option value="${esc(s.name)}" ${s.name === config.skin ? 'selected' : ''}>${esc(s.displayName)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>体型缩放</label>
          <input type="number" name="scale" min="0.6" max="2" step="0.1" value="${config.window?.scale ?? 1}">
        </div>
      </div>
      <div class="check"><input type="checkbox" name="alwaysOnTop" ${config.window?.alwaysOnTop !== false ? 'checked' : ''}><span>窗口置顶</span></div>
      <div class="check"><input type="checkbox" name="clickThrough" ${config.window?.clickThrough ? 'checked' : ''}><span>鼠标穿透（托盘菜单可恢复）</span></div>

      <div class="actions">
        <button class="btn-close" type="button">关闭</button>
        <button class="btn-save" type="button">保存并连接</button>
      </div>
      <div class="hint">读取服务的 /health 与 /metrics（vllm:num_requests_running / waiting、gpu_cache_usage_perc）。右键宠物可随时打开本面板。</div>
    `
    anchorEl.append(el)
    this.el = el

    el.querySelector('.btn-close').addEventListener('click', () => this.close())
    el.querySelector('.btn-save').addEventListener('click', async () => {
      const get = (n) => el.querySelector(`[name="${n}"]`)
      const num = (n, fallback) => {
        const v = Number(get(n).value)
        return Number.isFinite(v) && v > 0 ? v : fallback
      }
      const patch = {
        apiBase: get('apiBase').value.trim(),
        apiKey: get('apiKey').value.trim(),
        pollIntervalMs: num('pollIntervalMs', 2000),
        skin: get('skin').value,
        thresholds: {
          light: num('tLight', 1),
          medium: num('tMedium', 4),
          heavy: num('tHeavy', 16),
          cacheHeavy: num('tCache', 0.85)
        },
        stateMap: {
          light: get('animLight').value,
          medium: get('animMedium').value,
          heavy: get('animHeavy').value
        },
        window: {
          alwaysOnTop: get('alwaysOnTop').checked,
          clickThrough: get('clickThrough').checked,
          scale: num('scale', 1)
        }
      }
      const saved = await this.provider.saveConfig(patch)
      this.onSaved(saved)
      const btn = el.querySelector('.btn-save')
      btn.textContent = '已保存 ✓'
      btn.disabled = true
      if (this.pageMode) {
        setTimeout(() => this.close(), 500)
      } else {
        this.close()
      }
    })
  }

  close() {
    this.el?.remove()
    this.el = null
    this.onClose()
  }

  toggle(anchorEl) {
    if (this.el) this.close()
    else this.open(anchorEl)
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}
