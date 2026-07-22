/**
 * download.js — 文件下载与 zip 解压（纯 Node，无 Electron 依赖，便于单测）
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * 下载 url 到 dest（自动跟随重定向，带进度回调）。
 * @param {string} url
 * @param {string} dest 目标文件路径（父目录自动创建）
 * @param {(received: number, total: number) => void} [onProgress] total 可能为 0（未知）
 * @param {number} [timeoutMs]
 * @returns {Promise<number>} 实际写入字节数
 */
export async function downloadFile(url, dest, onProgress, timeoutMs = 120_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'vllm-pet-updater' },
      signal: ctrl.signal
    })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    let received = 0
    const source = Readable.fromWeb(res.body)
    source.on('data', (chunk) => {
      received += chunk.length
      onProgress?.(received, total)
    })
    const out = fs.createWriteStream(dest)
    await pipeline(source, out)
    return received
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解压 zip 到 destDir。macOS 优先 ditto（正确保留 .app 内的符号链接与元数据），
 * 其他平台退到 unzip。仅供 macOS 自更新链路使用。
 */
export async function extractZip(zipPath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })
  if (process.platform === 'darwin') {
    await execFileP('ditto', ['-xk', zipPath, destDir])
  } else {
    await execFileP('unzip', ['-o', '-q', zipPath, '-d', destDir])
  }
  return destDir
}

/** 在目录里找第一个 *.app 包名（macOS 自更新用） */
export function findAppBundle(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return path.join(dir, entry.name)
    }
  }
  return null
}
