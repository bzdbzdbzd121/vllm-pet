/**
 * preload.cjs — contextBridge，向渲染层暴露 window.vllmPet
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vllmPet', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  onStatus: (cb) => {
    const listener = (_event, snap) => cb(snap)
    ipcRenderer.on('status:update', listener)
    return () => ipcRenderer.removeListener('status:update', listener)
  },
  onOpenSettings: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('ui:open-settings', listener)
    return () => ipcRenderer.removeListener('ui:open-settings', listener)
  },
  onConfigChanged: (cb) => {
    const listener = (_event, config) => cb(config)
    ipcRenderer.on('config:changed', listener)
    return () => ipcRenderer.removeListener('config:changed', listener)
  },
  // 穿透悬停：模式（是否处于穿透悬停会话）+ 主进程轮询到的光标（0..1 归一化，null = 不在窗口内）
  onHoverMode: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('hover:mode', listener)
    return () => ipcRenderer.removeListener('hover:mode', listener)
  },
  onHoverCursor: (cb) => {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('hover:cursor', listener)
    return () => ipcRenderer.removeListener('hover:cursor', listener)
  },
  getHoverState: () => ipcRenderer.invoke('hover:cursor:get'),
  // 诊断（VLLM_PET_DEBUG_HOVER=1）：渲染层把状态源/锁存/清状态栈发到主进程统一打印
  debugHoverEnabled: process.env.VLLM_PET_DEBUG_HOVER === '1',
  debugHover: (msg) => ipcRenderer.send('hover:debug', String(msg)),
  // 事件源存活证明：渲染层收到「带坐标的转发指针事件」时上报一次（穿透会话内）
  reportHoverEvent: () => ipcRenderer.send('hover:event'),

  onPowerPause: (cb) => {
    const listener = (_event, paused) => cb(paused)
    ipcRenderer.on('power:pause', listener)
    return () => ipcRenderer.removeListener('power:pause', listener)
  },
  openSettings: () => ipcRenderer.send('settings:open'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),

  listSkins: () => ipcRenderer.invoke('skins:list'),
  loadSkin: (name) => ipcRenderer.invoke('skins:load', name),

  setClickThrough: (v) => ipcRenderer.send('window:click-through', v),
  setAlwaysOnTop: (v) => ipcRenderer.send('window:always-on-top', v),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  quit: () => ipcRenderer.send('app:quit'),

  platform: process.platform
})
