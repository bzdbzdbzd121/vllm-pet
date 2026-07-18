/**
 * settings-panel.js — 气泡式设置面板（桌宠窗口与预览页共用）
 */
import { listAvailableSkins } from '../skins/skin-loader.js'

export class SettingsPanel {
  /**
   * @param {{
   *   provider: { getConfig(): Promise<object>, saveConfig(p: object): Promise<object> },
   *   bridge?: object|null,       // window.vllmPet（浏览器预览时为 null）
   *   onSaved?: (config: object) => void,
   *   onClose?: () => void
   * }} opts
   */
  constructor({ provider, bridge = null, onSaved, onClose }) {
    this.provider = provider
    this.bridge = bridge
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

    const el = document.createElement('div')
    el.className = 'pet-settings'
    el.innerHTML = `
      <h3>⚙️ 小V 设置</h3>
      <label>vLLM 服务地址</label>
      <input type="text" name="apiBase" placeholder="http://127.0.0.1:8000" value="${esc(config.apiBase)}">
      <label>API Key（可选）</label>
      <input type="password" name="apiKey" placeholder="留空则不携带鉴权头" value="${esc(config.apiKey)}">
      <div class="row">
        <div>
          <label>轮询间隔 (ms)</label>
          <input type="number" name="pollIntervalMs" min="500" max="60000" step="100" value="${config.pollIntervalMs}">
        </div>
        <div>
          <label>体型缩放</label>
          <input type="number" name="scale" min="0.6" max="2" step="0.1" value="${config.window?.scale ?? 1}">
        </div>
      </div>
      <label>皮肤</label>
      <select name="skin">
        ${skins.map((s) => `<option value="${esc(s.name)}" ${s.name === config.skin ? 'selected' : ''}>${esc(s.displayName)}</option>`).join('')}
      </select>
      <div class="check"><input type="checkbox" name="alwaysOnTop" ${config.window?.alwaysOnTop !== false ? 'checked' : ''}><span>窗口置顶</span></div>
      <div class="check"><input type="checkbox" name="clickThrough" ${config.window?.clickThrough ? 'checked' : ''}><span>鼠标穿透（托盘菜单可恢复）</span></div>
      <details>
        <summary>高级：负载阈值</summary>
        <div class="row">
          <div><label>轻载 ≥</label><input type="number" name="tLight" min="1" value="${config.thresholds?.light ?? 1}"></div>
          <div><label>中载 ≥</label><input type="number" name="tMedium" min="1" value="${config.thresholds?.medium ?? 4}"></div>
        </div>
        <div class="row">
          <div><label>重载 ≥</label><input type="number" name="tHeavy" min="1" value="${config.thresholds?.heavy ?? 16}"></div>
          <div><label>KV 重载 ≥</label><input type="number" name="tCache" min="0.1" max="1" step="0.05" value="${config.thresholds?.cacheHeavy ?? 0.85}"></div>
        </div>
      </details>
      <div class="actions">
        <button class="btn-close" type="button">关闭</button>
        <button class="btn-save" type="button">保存并连接</button>
      </div>
      <div class="hint">读取服务的 /health 与 /metrics（vllm:num_requests_running / waiting、gpu_cache_usage_perc）。右键宠物可随时重新打开本面板。</div>
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
        window: {
          alwaysOnTop: get('alwaysOnTop').checked,
          clickThrough: get('clickThrough').checked,
          scale: num('scale', 1)
        }
      }
      const saved = await this.provider.saveConfig(patch)
      this.onSaved(saved)
      this.close()
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
