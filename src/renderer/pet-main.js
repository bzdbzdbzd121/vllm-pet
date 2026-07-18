/**
 * pet-main.js — 桌宠窗口入口（Electron 加载本页；浏览器打开时降级为 Mock 演示）
 */
import './robot/robot.css'
import { PetView } from './robot/pet.js'
import { PetStateMachine } from './status/state-machine.js'
import { IpcStatusProvider, MockStatusProvider } from './status/providers.js'
import { SettingsPanel } from './ui/settings-panel.js'
import { resolveSkin } from './skins/skin-loader.js'

async function boot() {
  const bridge = typeof window !== 'undefined' ? window.vllmPet : null
  const provider = IpcStatusProvider.available() ? new IpcStatusProvider(bridge) : new MockStatusProvider()

  const config = await provider.getConfig()
  const skin = await resolveSkin(config.skin, bridge)

  const app = document.getElementById('app')
  const pet = new PetView(app, { skin, scale: config.window?.scale ?? 1 })
  pet.setStatusLine('连接中…')

  const machine = new PetStateMachine({
    idleSleepMinutes: config.idleSleepMinutes ?? 10,
    onVisualState: (visual) => pet.setState(visual),
    onStatusLine: (text) => pet.setStatusLine(text),
    onCelebrate: () => pet.celebrate()
  })

  provider.start((snap) => machine.update(snap))

  const settings = new SettingsPanel({
    provider,
    bridge,
    onSaved: async (saved) => {
      machine.setIdleSleepMinutes(saved.idleSleepMinutes ?? 10)
      pet.setScale(saved.window?.scale ?? 1)
      const nextSkin = await resolveSkin(saved.skin, bridge)
      pet.applySkin(nextSkin)
    }
  })

  // 首次运行（未配置服务地址）自动弹出设置
  if (IpcStatusProvider.available() && !config.apiBase) {
    settings.open(pet.stage)
    pet.setStatusLine('先帮我配置 vLLM 服务地址吧')
  }

  // 右键打开 / 关闭设置
  pet.stage.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    settings.toggle(pet.stage)
  })

  // 托盘"打开设置"
  bridge?.onOpenSettings?.(() => settings.open(pet.stage))

  // 拖动（按下机器人本体开始拖动，松开结束；设置面板内的交互不触发）
  pet.stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.pet-settings')) return
    bridge?.dragStart?.()
    const up = () => {
      bridge?.dragEnd?.()
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mouseup', up)
  })
}

boot().catch((err) => {
  console.error('[vllm-pet] 启动失败', err)
  document.body.innerHTML = `<pre style="color:#f66;background:#200;padding:12px;font:12px monospace">启动失败：${String(err?.message || err)}</pre>`
})
