/**
 * preview-main.js — 浏览器预览/演示页：手动切换状态 + 可选真实直连
 */
import './robot/robot.css'
import { PetView } from './robot/pet.js'
import { PetStateMachine } from './status/state-machine.js'
import { MockStatusProvider, LiveFetchProvider } from './status/providers.js'
import { SettingsPanel } from './ui/settings-panel.js'
import { resolveSkin } from './skins/skin-loader.js'

const DEMOS = [
  { key: 'idle', label: '😌 空闲', snap: { state: 'idle', intensity: 0, running: 0, waiting: 0, cacheUsage: 0.31, error: null } },
  { key: 'busy-1', label: '💨 轻载', snap: { state: 'busy', intensity: 1, running: 2, waiting: 0, cacheUsage: 0.42, error: null } },
  { key: 'busy-2', label: '💦 中载', snap: { state: 'busy', intensity: 2, running: 7, waiting: 3, cacheUsage: 0.66, error: null } },
  { key: 'busy-3', label: '🔥 重载', snap: { state: 'busy', intensity: 3, running: 24, waiting: 9, cacheUsage: 0.91, error: null } },
  { key: 'connecting', label: '📡 连接中', snap: { state: 'connecting', intensity: 0, running: 0, waiting: 0, cacheUsage: null, error: null } },
  { key: 'offline', label: '🔌 离线', snap: { state: 'offline', intensity: 0, running: 0, waiting: 0, cacheUsage: null, error: '连接超时' } }
]

async function boot() {
  const mock = new MockStatusProvider()
  const config = await mock.getConfig()
  const skin = await resolveSkin(config.skin, null)

  const holder = document.getElementById('pet-holder')
  const pet = new PetView(holder, { skin, scale: 1 })
  const snapshotEl = document.getElementById('snapshot')

  const machine = new PetStateMachine({
    idleSleepMinutes: config.idleSleepMinutes ?? 10,
    stateMap: config.stateMap,
    onVisualState: (visual) => pet.setState(visual),
    onStatusLine: (text) => pet.setStatusLine(text),
    onCelebrate: () => pet.celebrate()
  })
  mock.start((snap) => {
    machine.update(snap)
    snapshotEl.textContent = JSON.stringify(snap, null, 2)
  })

  // 状态演示按钮
  const grid = document.getElementById('state-grid')
  const buttons = new Map()
  let live = null
  const stopLive = () => {
    live?.stop()
    live = null
    document.getElementById('btn-live').textContent = '连接'
  }
  const activate = (key) => {
    for (const [k, b] of buttons) b.classList.toggle('active', k === key)
  }
  for (const demo of DEMOS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = demo.label
    btn.addEventListener('click', () => {
      stopLive()
      activate(demo.key)
      mock.push(demo.snap)
    })
    grid.append(btn)
    buttons.set(demo.key, btn)
  }
  // 睡觉 + 庆祝两个特殊动作
  const sleepBtn = document.createElement('button')
  sleepBtn.type = 'button'
  sleepBtn.textContent = '💤 睡觉'
  sleepBtn.addEventListener('click', () => {
    stopLive()
    activate('__sleep')
    pet.setState('sleeping')
    pet.setStatusLine('Zzz…（连续空闲后自动进入）')
  })
  const celebrateBtn = document.createElement('button')
  celebrateBtn.type = 'button'
  celebrateBtn.textContent = '🎉 庆祝'
  celebrateBtn.addEventListener('click', () => pet.celebrate())
  grid.append(sleepBtn, celebrateBtn)
  buttons.set('__sleep', sleepBtn)

  // 真实直连
  document.getElementById('btn-live').addEventListener('click', () => {
    if (live) {
      stopLive()
      activate('')
      return
    }
    const apiBase = document.getElementById('api-base').value.trim()
    if (!apiBase) return
    activate('')
    live = new LiveFetchProvider({ ...config, apiBase })
    live.start((snap) => {
      machine.update(snap)
      snapshotEl.textContent = JSON.stringify(snap, null, 2)
    })
    document.getElementById('btn-live').textContent = '断开'
  })

  // 设置面板
  const settings = new SettingsPanel({
    provider: mock,
    bridge: null,
    onSaved: async (saved) => {
      machine.setIdleSleepMinutes(saved.idleSleepMinutes ?? 10)
      machine.setStateMap(saved.stateMap)
      pet.applySkin(await resolveSkin(saved.skin, null))
      Object.assign(config, saved)
    }
  })
  document.getElementById('btn-settings').addEventListener('click', () => {
    settings.toggle(document.getElementById('settings-slot'))
  })

  activate('idle')
  mock.push(DEMOS[0].snap)
}

boot().catch((err) => {
  console.error('[vllm-pet] 预览页启动失败', err)
})
