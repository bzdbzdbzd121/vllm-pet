/**
 * settings-main.js — 独立设置窗口入口
 */
import './robot/robot.css'
import { SettingsPanel } from './ui/settings-panel.js'
import { IpcStatusProvider, MockStatusProvider } from './status/providers.js'

async function boot() {
  const bridge = typeof window !== 'undefined' ? window.vllmPet : null
  const provider = IpcStatusProvider.available() ? new IpcStatusProvider(bridge) : new MockStatusProvider()

  const panel = new SettingsPanel({
    provider,
    bridge,
    pageMode: true,
    onClose: () => {
      // 独立窗口：关闭面板 = 关闭窗口
      if (IpcStatusProvider.available()) window.close()
    }
  })
  await panel.open(document.getElementById('settings-root'))
}

boot().catch((err) => {
  console.error('[vllm-pet] 设置窗口启动失败', err)
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;font:12px monospace">启动失败：${String(err?.message || err)}</pre>`
})
