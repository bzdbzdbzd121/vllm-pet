/**
 * main.js — Electron 主进程：透明无边框桌宠窗口 + 托盘 + 轮询服务 + IPC
 *
 * 环境变量：
 *   VLLM_PET_DEV=1    加载 vite dev server（http://localhost:5173/pet.html）
 *   VLLM_PET_SMOKE=1  冒烟模式：临时 userData、隐藏窗口、截图后自动退出
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from './config-store.js'
import { PollerService } from './poller-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const BASE_W = 240
const BASE_H = 280

const SMOKE = process.env.VLLM_PET_SMOKE === '1'
const DEV = process.env.VLLM_PET_DEV === '1'

if (SMOKE) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-pet-smoke-'))
  app.setPath('userData', tmp)
  console.log('[smoke] userData =', tmp)
}

let win = null
let settingsWin = null
let tray = null
let store = null
let poller = null
let dragSession = null

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const config = store.load()
  // 冒烟模式可用环境变量指定页面与窗口尺寸（便于截预览页/大尺寸）
  const smokePage = SMOKE ? (process.env.VLLM_PET_SMOKE_PAGE || 'pet.html') : null
  const smokeSize = SMOKE && process.env.VLLM_PET_SMOKE_SIZE
    ? process.env.VLLM_PET_SMOKE_SIZE.split('x').map(Number)
    : null
  const scale = Number(config.window?.scale) > 0 ? Number(config.window.scale) : 1
  const w = smokeSize?.[0] || Math.round(BASE_W * scale)
  const h = smokeSize?.[1] || Math.round(BASE_H * scale)

  let x = config.window?.x
  let y = config.window?.y
  if (typeof x !== 'number' || typeof y !== 'number') {
    const area = screen.getPrimaryDisplay().workArea
    x = area.x + area.width - w - 40
    y = area.y + area.height - h - 20
  }

  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: !SMOKE,
    alwaysOnTop: config.window?.alwaysOnTop !== false,
    opacity: config.window?.opacity ?? 1,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.setAlwaysOnTop(config.window?.alwaysOnTop !== false, 'screen-saver')
  if (config.window?.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })

  if (DEV) {
    win.loadURL('http://localhost:5173/pet.html')
  } else {
    win.loadFile(path.join(ROOT, 'dist', smokePage || 'pet.html'))
  }

  win.on('closed', () => { win = null })
  if (SMOKE) runSmokeCapture()
  return win
}

/** 配置变更后即时应用窗口相关字段 */
function applyWindowConfig(config) {
  if (!win) return
  const scale = Number(config.window?.scale) > 0 ? Number(config.window.scale) : 1
  win.setSize(Math.round(BASE_W * scale), Math.round(BASE_H * scale))
  win.setAlwaysOnTop(config.window?.alwaysOnTop !== false, 'screen-saver')
  win.setIgnoreMouseEvents(!!config.window?.clickThrough, { forward: true })
  if (typeof config.window?.opacity === 'number') win.setOpacity(config.window.opacity)
}

/* ---------------- 托盘 ---------------- */
function createTray() {
  const iconPath = path.join(ROOT, 'build', 'icons', 'trayTemplate.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  if (process.platform === 'darwin') image.setTemplateImage(true)

  tray = new Tray(image)
  tray.setToolTip('vLLM Pet · 小V')
  rebuildTrayMenu()
}

function rebuildTrayMenu() {
  if (!tray) return
  const config = store.load()
  const menu = Menu.buildFromTemplate([
    { label: '⚙️ 打开设置', click: () => openSettingsWindow() },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: config.window?.alwaysOnTop !== false,
      click: (item) => store.save({ window: { alwaysOnTop: item.checked } }) && applyAndRefresh()
    },
    {
      label: '鼠标穿透',
      type: 'checkbox',
      checked: !!config.window?.clickThrough,
      click: (item) => store.save({ window: { clickThrough: item.checked } }) && applyAndRefresh()
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

function applyAndRefresh() {
  applyWindowConfig(store.load())
  rebuildTrayMenu()
}

/* ---------------- 设置窗口 ---------------- */
function openSettingsWindow() {
  if (settingsWin) {
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 420,
    minHeight: 560,
    show: !SMOKE,
    title: 'vLLM Pet 设置',
    autoHideMenuBar: true,
    backgroundColor: '#0e1a22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.platform === 'darwin') app.dock?.show()
  if (DEV) {
    settingsWin.loadURL('http://localhost:5173/settings.html')
  } else {
    settingsWin.loadFile(path.join(ROOT, 'dist', 'settings.html'))
  }
  settingsWin.on('closed', () => {
    settingsWin = null
    // 设置窗关闭后恢复无 Dock 图标（桌宠常驻托盘）
    if (process.platform === 'darwin' && !SMOKE) app.dock?.hide()
  })
}

/* ---------------- 皮肤目录 ---------------- */
function skinsDir() {
  return path.join(app.getPath('userData'), 'skins')
}

function listSkins() {
  const list = [{ name: 'default-robot', displayName: '小V · 默认机器人', builtin: true }]
  try {
    for (const entry of fs.readdirSync(skinsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skinFile = path.join(skinsDir(), entry.name, 'skin.json')
      if (!fs.existsSync(skinFile)) continue
      try {
        const json = JSON.parse(fs.readFileSync(skinFile, 'utf8'))
        list.push({
          name: entry.name,
          displayName: json.displayName || entry.name,
          builtin: false
        })
      } catch { /* 跳过损坏皮肤 */ }
    }
  } catch { /* skins 目录不存在 */ }
  return list
}

function loadSkin(name) {
  if (typeof name !== 'string' || /[\\/]|\.\./.test(name)) return null
  const dir = path.join(skinsDir(), name)
  const skinFile = path.join(dir, 'skin.json')
  if (!fs.existsSync(skinFile)) return null
  try {
    const json = JSON.parse(fs.readFileSync(skinFile, 'utf8'))
    const assets = {}
    for (const file of fs.readdirSync(dir)) {
      const ext = path.extname(file).toLowerCase()
      const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext]
      if (!mime) continue
      const buf = fs.readFileSync(path.join(dir, file))
      assets[file] = `data:${mime};base64,${buf.toString('base64')}`
    }
    return { ...json, name, assets }
  } catch {
    return null
  }
}

/* ---------------- 拖动 ---------------- */
function startDrag() {
  if (!win || dragSession) return
  const startCursor = screen.getCursorScreenPoint()
  const [startX, startY] = win.getPosition()
  dragSession = setInterval(() => {
    if (!win) return
    const cursor = screen.getCursorScreenPoint()
    win.setPosition(startX + cursor.x - startCursor.x, startY + cursor.y - startCursor.y)
  }, 16)
}

function endDrag() {
  if (!dragSession) return
  clearInterval(dragSession)
  dragSession = null
  if (win) {
    const [x, y] = win.getPosition()
    store.save({ window: { x, y } })
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('config:get', () => store.load())
  ipcMain.handle('config:save', (_e, patch) => {
    const saved = store.save(patch && typeof patch === 'object' ? patch : {})
    applyWindowConfig(saved)
    rebuildTrayMenu()
    poller.restart()
    // 通知宠物窗口应用新配置（动画映射/皮肤/睡眠时长等）
    win?.webContents.send('config:changed', saved)
    return saved
  })
  ipcMain.handle('skins:list', () => listSkins())
  ipcMain.handle('skins:load', (_e, name) => loadSkin(name))
  ipcMain.on('settings:open', () => openSettingsWindow())
  ipcMain.on('window:click-through', (_e, v) => {
    store.save({ window: { clickThrough: !!v } })
    applyAndRefresh()
  })
  ipcMain.on('window:always-on-top', (_e, v) => {
    store.save({ window: { alwaysOnTop: !!v } })
    applyAndRefresh()
  })
  ipcMain.on('drag:start', startDrag)
  ipcMain.on('drag:end', endDrag)
  ipcMain.on('app:quit', () => app.quit())
}

/* ---------------- 冒烟模式 ---------------- */
function runSmokeCapture() {
  const deadline = setTimeout(() => {
    console.error('[smoke] 超时：页面未就绪')
    app.exit(1)
  }, 20000)

  win.webContents.once('did-finish-load', () => {
    // 默认 2.5s；需要捕获离线等延迟状态时用 VLLM_PET_SMOKE_DELAY 加大
    const delay = Math.max(0, Number(process.env.VLLM_PET_SMOKE_DELAY) || 2500)
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        const out = path.join(process.cwd(), 'smoke-pet.png')
        fs.writeFileSync(out, image.toPNG())
        console.log('[smoke] 截图已保存:', out)
        clearTimeout(deadline)
        app.exit(0)
      } catch (err) {
        console.error('[smoke] 截图失败', err)
        clearTimeout(deadline)
        app.exit(1)
      }
    }, 2500)
  })
}

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus() }
  })

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide()
    store = new ConfigStore(app.getPath('userData'))
    // 冒烟模式可预置服务地址（指向 mock-vllm 做端到端验证）
    if (SMOKE && process.env.VLLM_PET_SMOKE_APIBASE) {
      store.save({ apiBase: process.env.VLLM_PET_SMOKE_APIBASE })
    }
    // 冒烟模式可预置缩放，验证放大后状态文本布局
    if (SMOKE && process.env.VLLM_PET_SMOKE_SCALE) {
      const s = Number(process.env.VLLM_PET_SMOKE_SCALE)
      if (Number.isFinite(s) && s > 0) store.save({ window: { scale: s } })
    }
    registerIpc()
    createWindow()
    if (!SMOKE) {
      createTray()
      poller = new PollerService({
        getConfig: () => store.load(),
        onStatus: (snap) => win?.webContents.send('status:update', snap)
      })
      poller.start()
      // 首次运行（未配置服务地址）自动打开设置窗口
      if (!store.load().apiBase) openSettingsWindow()
    } else {
      // 冒烟模式仍创建 poller 以验证装配；apiBase 默认空 → 不会访问外网
      poller = new PollerService({
        getConfig: () => store.load(),
        onStatus: (snap) => {
          console.log('[smoke] state =', snap.state, 'err =', snap.error || '')
          win?.webContents.send('status:update', snap)
        }
      })
      poller.start()
    }
  })

  app.on('window-all-closed', () => {
    // 桌宠常驻托盘，关窗不退出；仅非 darwin 且无托盘时退出
    if (SMOKE) app.quit()
  })
  app.on('before-quit', () => {
    poller?.stop()
    endDrag()
  })
}
