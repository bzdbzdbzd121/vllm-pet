#!/usr/bin/env node
/**
 * smoke.mjs — 集成冒烟：以隐藏窗口启动 Electron 加载 dist/pet.html，
 * 渲染 2.5s 后截图 smoke-pet.png 并退出。
 *
 * 前置：先执行 npm run build。
 * 用法：node scripts/smoke.mjs
 * 环境变量：
 *   VLLM_PET_SMOKE_APIBASE  预置服务地址（通常指向 mock-vllm）
 *   VLLM_PET_SMOKE_SCALE    预置体型缩放（如 0.7 / 1.5）
 *   VLLM_PET_SMOKE_SKIN     预置皮肤名（验证内置换色皮肤）
 *   VLLM_PET_SMOKE_PAGE     指定加载页面（默认 pet.html）
 *   VLLM_PET_SMOKE_SIZE     指定窗口尺寸（如 480x560）
 *   VLLM_PET_SMOKE_DELAY    did-finish-load 后延迟多少毫秒再截图（默认 2500，
 *                           验证离线等延迟状态时加大，并配合 pkill mock）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

if (!fs.existsSync(path.join(ROOT, 'dist', 'pet.html'))) {
  console.error('[smoke] 未找到 dist/pet.html，请先运行 npm run build')
  process.exit(1)
}

const electronBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron')
const child = spawn(electronBin, ['.'], {
  cwd: ROOT,
  env: { ...process.env, VLLM_PET_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: isWin
})

let sawOk = false
child.stdout.on('data', (chunk) => {
  const text = String(chunk)
  process.stdout.write(text)
  if (text.includes('[smoke] 截图已保存')) sawOk = true
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

const killer = setTimeout(() => {
  console.error('[smoke] 超时，强制结束')
  child.kill('SIGKILL')
  process.exit(1)
}, 45000)

child.on('exit', (code) => {
  clearTimeout(killer)
  const png = path.join(ROOT, 'smoke-pet.png')
  if (code === 0 && sawOk && fs.existsSync(png)) {
    console.log('[smoke] 通过 ✅')
    process.exit(0)
  }
  console.error(`[smoke] 失败 (exit=${code}, sawOk=${sawOk}, png=${fs.existsSync(png)})`)
  process.exit(1)
})
