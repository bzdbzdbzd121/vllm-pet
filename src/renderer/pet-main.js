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
  const hasBridge = IpcStatusProvider.available()
  const provider = hasBridge ? new IpcStatusProvider(bridge) : new MockStatusProvider()

  const config = await provider.getConfig()
  const skin = await resolveSkin(config.skin, bridge)

  const app = document.getElementById('app')
  const pet = new PetView(app, { skin, scale: config.window?.scale ?? 1 })

  let statusEnabled = config.showStatus !== false
  let lastStatusText = ''
  const applyStatusLine = (text) => {
    lastStatusText = text
    pet.setStatusLine(statusEnabled ? text : '')
  }
  applyStatusLine(config.apiBase ? '连接中…' : '尚未配置服务地址，右键打开设置')

  const machine = new PetStateMachine({
    idleSleepMinutes: config.idleSleepMinutes ?? 10,
    stateMap: config.stateMap,
    onVisualState: (visual) => pet.setState(visual),
    onStatusLine: applyStatusLine,
    onCelebrate: () => pet.celebrate()
  })

  provider.start((snap) => machine.update(snap))

  /** 应用新配置（设置窗口保存后由主进程广播，或内嵌面板保存后本地回调） */
  const applyConfig = async (saved) => {
    machine.setIdleSleepMinutes(saved.idleSleepMinutes ?? 10)
    machine.setStateMap(saved.stateMap)
    statusEnabled = saved.showStatus !== false
    pet.setStatusLine(statusEnabled ? lastStatusText : '')
    pet.setScale(saved.window?.scale ?? 1)
    pet.applySkin(await resolveSkin(saved.skin, bridge))
  }

  // 浏览器/Mock 降级：内嵌气泡设置面板（桌面版走独立设置窗口）
  const inlineSettings = new SettingsPanel({ provider, bridge, onSaved: applyConfig })

  // 右键打开设置：桌面版 → 独立设置窗口；浏览器 → 内嵌气泡
  pet.stage.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (hasBridge && bridge.openSettings) bridge.openSettings()
    else inlineSettings.toggle(pet.stage)
  })

  // 兼容入口：主进程旧式 ui:open-settings 事件
  bridge?.onOpenSettings?.(() => {
    if (hasBridge && bridge.openSettings) bridge.openSettings()
    else inlineSettings.open(pet.stage)
  })

  // 设置窗口保存后同步新配置
  bridge?.onConfigChanged?.((saved) => applyConfig(saved))

  // 浏览器 Mock 模式下未配置地址时自动弹出内嵌面板（桌面版由主进程打开设置窗口）
  if (!hasBridge && !config.apiBase) {
    inlineSettings.open(pet.stage)
  }

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
