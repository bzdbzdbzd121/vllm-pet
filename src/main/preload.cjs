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
  openSettings: () => ipcRenderer.send('settings:open'),

  listSkins: () => ipcRenderer.invoke('skins:list'),
  loadSkin: (name) => ipcRenderer.invoke('skins:load', name),

  setClickThrough: (v) => ipcRenderer.send('window:click-through', v),
  setAlwaysOnTop: (v) => ipcRenderer.send('window:always-on-top', v),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  quit: () => ipcRenderer.send('app:quit'),

  platform: process.platform
})
