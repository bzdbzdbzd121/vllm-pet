/**
 * main.js — Electron 主进程：透明无边框桌宠窗口 + 托盘 + 轮询服务 + IPC
 *
 * 环境变量：
 *   VLLM_PET_DEV=1    加载 vite dev server（http://localhost:5173/pet.html）
 *   VLLM_PET_SMOKE=1  冒烟模式：临时 userData、隐藏窗口、截图后自动退出
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, powerMonitor } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from './config-store.js'
import { createHoverMonitor, shouldRunHoverMonitor } from './hover-monitor.js'
import { PollerService } from './poller-service.js'
import { UpdateService } from './updater.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const BASE_W = 240
const BASE_H = 280
/* 状态气泡已收入舞台底部留白区，窗口无需额外加高 */
const STATUS_H = 0

/** 按缩放与是否显示状态文本计算窗口尺寸 */
function windowSize(config) {
  const scale = Number(config.window?.scale) > 0 ? Number(config.window.scale) : 1
  const extra = config.showStatus === false ? 0 : STATUS_H
  return [Math.round(BASE_W * scale), Math.round((BASE_H + extra) * scale)]
}

const SMOKE = process.env.VLLM_PET_SMOKE === '1'
const DEV = process.env.VLLM_PET_DEV === '1'

if (SMOKE) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-pet-smoke-'))
  app.setPath('userData', tmp)
  console.log('[smoke] userData =', tmp)
}

/**
 * 平台闸门：只有 Windows/macOS 进入「穿透 + 悬停」路径（阶段 0 裁决 §2.2）。
 * Linux 恒 false，理由（实测，勿随手加回来）：
 *   1) 上游 electron#52456：43.x 在 X11 上 setIgnoreMouseEvents 不生效，点击被吞；
 *   2) 穿透模式（ignore=true）下 screen.getCursorScreenPoint() 读数冻结 —— 单信号无法自证，
 *      冻结检测不成立，只能靠平台闸门。
 * 保留 true 的前提：该平台通过阶段 0 裁决 §3「2A」的三项实测（穿透有效 / forward 有效 / 读数不冻结）。
 */
const HOVER_SUPPORTED_PLATFORMS = ['win32', 'darwin']
const HOVER_SUPPORTED = HOVER_SUPPORTED_PLATFORMS.includes(process.platform)

let win = null
let settingsWin = null
let hoverMonitor = null
let hoverMode = false // 当前推给渲染层的「穿透悬停会话是否激活」
let powerPaused = false // 锁屏/休眠（与 power:pause 广播同步）
let tray = null
let store = null
let poller = null
let updater = null
let dragSession = null

/* ---------------- 穿透悬停监控 ---------------- */
/**
 * 会话条件：穿透开 + 悬停功能开 + 窗口可见 + 未最小化 + 未锁屏 + 非冒烟（+ 平台支持）。
 * 平台不支持时 shouldRunHoverMonitor 恒 false → 零行为（不起定时器、不推送、状态不变）。
 */
function hoverSessionActive() {
  if (!win || win.isDestroyed()) return false
  const config = store.load()
  return shouldRunHoverMonitor({
    supported: HOVER_SUPPORTED,
    clickThrough: !!config.window?.clickThrough,
    enabled: config.hoverFade?.enabled !== false,
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    locked: powerPaused,
    smoke: SMOKE
  })
}

function initHoverMonitor() {
  if (hoverMonitor) return hoverMonitor
  hoverMonitor = createHoverMonitor({
    supported: HOVER_SUPPORTED,
    getCursor: () => screen.getCursorScreenPoint(),
    getBounds: () => (win && !win.isDestroyed() ? win.getContentBounds() : null),
    send: (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('hover:cursor', payload)
    },
    log: (...args) => console.warn(...args),
    // 监控自己判定「读不到全局光标」→ 渲染层回到指针模式（失焦复位等行为也随之恢复）
    onDegrade: () => {
      hoverMode = false
      if (win && !win.isDestroyed()) win.webContents.send('hover:mode', { clickThrough: false })
    }
  })
  return hoverMonitor
}

/**
 * 同步「模式 + 监控」。
 * - 进入会话：先推模式（渲染层据此停用 blur 复位），再启动监控（首采样即种子）
 * - 退出会话：停监控（内部会推 null 清状态）再推模式
 * - `resend`：页面加载完成/重载后的握手，强制重发一次模式与当前光标
 */
function syncHoverMonitor({ resend = false } = {}) {
  if (!win || win.isDestroyed()) return
  initHoverMonitor()
  const active = hoverSessionActive()
  if (active === hoverMode) {
    if (active && resend) {
      win.webContents.send('hover:mode', { clickThrough: true })
      hoverMonitor.sync()
    }
    return
  }
  hoverMode = active
  if (active) {
    win.webContents.send('hover:mode', { clickThrough: true })
    hoverMonitor.start()
  } else {
    hoverMonitor.stop()
    win.webContents.send('hover:mode', { clickThrough: false })
  }
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  const config = store.load()
  // 冒烟模式可用环境变量指定页面与窗口尺寸（便于截预览页/大尺寸）
  const smokePage = SMOKE ? (process.env.VLLM_PET_SMOKE_PAGE || 'pet.html') : null
  const smokeSize = SMOKE && process.env.VLLM_PET_SMOKE_SIZE
    ? process.env.VLLM_PET_SMOKE_SIZE.split('x').map(Number)
    : null
  const [w, h] = smokeSize || windowSize(config)

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
  // 在所有桌面空间可见（macOS Spaces / Linux 工作区）：左右切换桌面时宠物不消失
  win.setVisibleOnAllWorkspaces(config.window?.allWorkspaces !== false, { visibleOnFullScreen: true })
  if (config.window?.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })

  if (DEV) {
    win.loadURL('http://localhost:5173/pet.html')
  } else {
    // 冒烟可经 VLLM_PET_SMOKE_HASH 带 hash（预览页 #skin=..&state=..）
    win.loadFile(path.join(ROOT, 'dist', smokePage || 'pet.html'), {
      hash: SMOKE ? (process.env.VLLM_PET_SMOKE_HASH || '') : ''
    })
  }

  // 穿透悬停：页面加载完成后握手（重发模式 + 当前光标），窗口可见性/最小化变化时同步
  initHoverMonitor()
  win.webContents.on('did-finish-load', () => syncHoverMonitor({ resend: true }))
  win.on('show', () => syncHoverMonitor())
  win.on('hide', () => syncHoverMonitor())
  win.on('minimize', () => syncHoverMonitor())
  win.on('restore', () => syncHoverMonitor())
  win.on('closed', () => {
    hoverMonitor?.stop()
    hoverMode = false
    win = null
  })
  if (SMOKE) runSmokeCapture()
  return win
}

/** 配置变更后即时应用窗口相关字段 */
function applyWindowConfig(config) {
  if (!win) return
  win.setSize(...windowSize(config))
  win.setAlwaysOnTop(config.window?.alwaysOnTop !== false, 'screen-saver')
  win.setVisibleOnAllWorkspaces(config.window?.allWorkspaces !== false, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(!!config.window?.clickThrough, { forward: true })
  if (typeof config.window?.opacity === 'number') win.setOpacity(config.window.opacity)
  // 穿透或功能开关变了 → 会话条件随之变化（不改 setIgnoreMouseEvents 的任何语义）
  syncHoverMonitor()
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

function rebuildTrayMenu(progressText = '') {
  if (!tray) return
  const config = store.load()
  const menu = Menu.buildFromTemplate([
    { label: '⚙️ 打开设置', click: () => openSettingsWindow() },
    { label: progressText || '🔄 检查更新', enabled: !progressText, click: () => updater?.check({ manual: true }) },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: config.window?.alwaysOnTop !== false,
      click: (item) => store.save({ window: { alwaysOnTop: item.checked } }) && applyAndRefresh()
    },
    // Windows 没有桌面空间概念，该选项仅 macOS/Linux 展示
    ...(process.platform === 'win32' ? [] : [{
      label: '在所有桌面显示',
      type: 'checkbox',
      checked: config.window?.allWorkspaces !== false,
      click: (item) => store.save({ window: { allWorkspaces: item.checked } }) && applyAndRefresh()
    }]),
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
  ipcMain.handle('update:check', () => updater?.check({ manual: true }))
  ipcMain.on('settings:open', () => openSettingsWindow())
  ipcMain.on('window:click-through', (_e, v) => {
    store.save({ window: { clickThrough: !!v } })
    applyAndRefresh()
  })
  ipcMain.on('window:always-on-top', (_e, v) => {
    store.save({ window: { alwaysOnTop: !!v } })
    applyAndRefresh()
  })
  // 穿透悬停：渲染层启动/重载后主动拉取一次（避免「启动时光标已在宠物上却不淡化」）
  ipcMain.handle('hover:cursor:get', () => {
    const state = hoverMonitor?.getState?.() || {}
    return {
      clickThrough: hoverMode,
      cursor: state.cursor ?? null,
      // 调试/验收用：来源与是否在轮询（渲染层不依赖这两个字段）
      source: state.source ?? null,
      running: !!state.running
    }
  })
  // 渲染层收到「带坐标的转发指针事件」时上报一次 → 事件源取得权威、主进程停轮询
  ipcMain.on('hover:event', () => hoverMonitor?.reportEvent({ hasCoords: true }))
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
      // 精度探针：只在冒烟模式下、且显式请求时生效（正常运行路径零影响）
      if (process.env.VLLM_PET_SMOKE_HOVER_PROBE === '1') {
        try {
          const probe = fs.readFileSync(path.join(ROOT, 'scripts', 'hover-probe.js'), 'utf8')
          const result = String(await win.webContents.executeJavaScript(probe))
          console.log('[hover-probe]', result)
          clearTimeout(deadline)
          // 探针自己给出结论：fail=0 才算通过（便于 scripts/probe-hover.mjs 汇总三档）
          app.exit(/\bfail=0\b/.test(result) ? 0 : 1)
        } catch (err) {
          console.error('[hover-probe] 采样失败', err)
          clearTimeout(deadline)
          app.exit(1)
        }
        return
      }
      try {
        if (process.env.VLLM_PET_SMOKE_DEBUG) {
          const dbg = await win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('.pet-status')
            if (!el) return 'no-el'
            const r = el.getBoundingClientRect()
            return JSON.stringify({ rectW: r.width, styleW: el.style.width,
              iw: innerWidth, text: el.textContent, bodyChildren: document.body.children.length })
          })()`)
          console.log('[smoke-debug]', dbg)
        }
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
    // 冒烟模式可预置皮肤，验证内置换色皮肤渲染
    if (SMOKE && process.env.VLLM_PET_SMOKE_SKIN) {
      store.save({ skin: process.env.VLLM_PET_SMOKE_SKIN })
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
      updater = new UpdateService({
        getAutoCheck: () => store.load().update?.autoCheck !== false,
        onProgress: (text) => {
          rebuildTrayMenu(text)
          tray?.setToolTip(text ? `vLLM Pet · ${text}` : 'vLLM Pet · 小V')
        },
        parentWindow: () => settingsWin || win
      })
      updater.scheduleAutoCheck()
      // 锁屏/系统休眠时暂停动画与轮询（省电）；恢复时 poller.start() 立即重新采样
      const setPowerPaused = (paused) => {
        powerPaused = !!paused
        win?.webContents.send('power:pause', paused)
        if (paused) poller?.stop()
        else poller?.start()
        // 锁屏/休眠：立即停穿透悬停并清状态；解锁/唤醒按当前光标重新判定
        syncHoverMonitor()
      }
      powerMonitor.on('suspend', () => setPowerPaused(true))
      powerMonitor.on('resume', () => setPowerPaused(false))
      powerMonitor.on('lock-screen', () => setPowerPaused(true))
      powerMonitor.on('unlock-screen', () => setPowerPaused(false))
      // 首次运行（未配置服务地址）自动打开设置窗口
      if (!store.load().apiBase) openSettingsWindow()
    } else {
      // 冒烟模式仍创建 poller 以验证装配；apiBase 默认空 → 不会访问外网
      poller = new PollerService({
        getConfig: () => store.load(),
        onStatus: (snap) => {
          console.log('[smoke] state =', snap.state, 'hint =', snap.hint || '', 'err =', snap.error || '')
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
    hoverMonitor?.stop()
    endDrag()
  })
}
