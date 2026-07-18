#!/usr/bin/env node
/**
 * dev-desktop.mjs — 启动 vite dev server + Electron 联调桌面桌宠。
 * 退出 Electron 窗口（或 Ctrl+C）时自动清理 vite 子进程。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV_URL = 'http://localhost:5173/pet.html'
const isWin = process.platform === 'win32'

const vite = spawn(isWin ? 'npx.cmd' : 'npx', ['vite', '--port', '5173', '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: isWin
})

let electron = null
let shuttingDown = false

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function cleanup(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  electron?.kill()
  vite.kill()
  process.exit(code)
}

process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))

const ok = await waitForServer(DEV_URL)
if (!ok) {
  console.error('[dev-desktop] vite dev server 启动超时')
  cleanup(1)
}

console.log('[dev-desktop] vite 就绪，启动 Electron…')
const electronBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron')
electron = spawn(electronBin, ['.'], {
  cwd: ROOT,
  env: { ...process.env, VLLM_PET_DEV: '1' },
  stdio: 'inherit',
  shell: isWin
})
electron.on('exit', (code) => cleanup(code ?? 0))
