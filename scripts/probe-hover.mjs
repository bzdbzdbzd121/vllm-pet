#!/usr/bin/env node
/**
 * probe-hover.mjs — 悬停命中区精度探针运行器
 *
 * 依次以 0.6 / 1 / 2 三档体型缩放启动隐藏的 Electron 窗口，把 scripts/hover-probe.js
 * 注入渲染页逐点核对（坐标表见方案附录 F），汇总三档结果；任一档失败则以非零退出。
 *
 * 前置：先 `npm run build`（与 scripts/smoke.mjs 一致）。
 * 用法：node scripts/probe-hover.mjs
 * 环境变量（透传）：VLLM_PET_SMOKE_DELAY 采样前等待毫秒（默认 1200，等状态机把舞台画好）
 *
 * 为什么复用冒烟模式：命中采样需要真实渲染页 + 真实的窗口尺寸（窗口尺寸 = 240×280 × 缩放），
 * 主进程只在 SMOKE 下接受 VLLM_PET_SMOKE_HOVER_PROBE=1（见 src/main/main.js），
 * 正常运行路径完全不受影响。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

/** 验收要求的三档缩放：0.6 / 1 / 2 */
export const SCALES = [0.6, 1, 2]

/** 从 Electron 的 stdout 里解析探针结果；没有结果行时返回 null */
export function parseProbeReport(stdout) {
  const m = /HOVER-PROBE scale=([\d.]+) pass=(\d+) fail=(\d+)/.exec(String(stdout || ''))
  if (!m) return null
  return { scale: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) }
}

/** 汇总三档结果：任一档失败或缺失即整体失败 */
export function summarize(results) {
  const lines = []
  let ok = true
  for (const scale of SCALES) {
    const r = results.find((x) => x.scale === scale)
    if (!r) {
      ok = false
      lines.push(`  scale=${scale} ❌ 没有拿到探针结果`)
      continue
    }
    if (r.fail > 0) ok = false
    lines.push(`  scale=${scale} ${r.fail === 0 ? '✅' : '❌'} pass=${r.pass} fail=${r.fail}`)
  }
  // 把失败明细（含具体坐标与期望值）一并带出来
  for (const r of results) {
    for (const line of r.details || []) lines.push(`  [scale=${r.scale}] ${line}`)
  }
  const head = ok ? '[probe] 命中区精度通过 ✅' : '[probe] 命中区精度失败 ❌'
  return { ok, text: `${head}\n${lines.join('\n')}` }
}

function runScale(scale) {
  return new Promise((resolve) => {
    const electronBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron')
    const child = spawn(electronBin, ['.'], {
      cwd: ROOT,
      env: {
        ...process.env,
        VLLM_PET_SMOKE: '1',
        VLLM_PET_SMOKE_HOVER_PROBE: '1',
        VLLM_PET_SMOKE_SCALE: String(scale),
        VLLM_PET_SMOKE_DELAY: process.env.VLLM_PET_SMOKE_DELAY || '1200'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += String(c); process.stdout.write(String(c)) })
    child.stderr.on('data', (c) => { stderr += String(c); process.stderr.write(String(c)) })

    const killer = setTimeout(() => {
      console.error(`[probe] scale=${scale} 超时，强制结束`)
      child.kill('SIGKILL')
    }, 45000)

    child.on('exit', (code) => {
      clearTimeout(killer)
      const report = parseProbeReport(stdout)
      if (!report) {
        console.error(`[probe] scale=${scale} 未拿到探针结果（exit=${code}）`)
        if (stderr) console.error(stderr.trim().split('\n').slice(-5).join('\n'))
      }
      const details = (stdout.match(/^\((.*)$/gm) || []).map((l) => l.trim())
      resolve({ scale, pass: report?.pass ?? 0, fail: report?.fail ?? (report ? 0 : 1), details })
    })
  })
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'pet.html'))) {
    console.error('[probe] 未找到 dist/pet.html，请先运行 npm run build')
    process.exit(1)
  }

  const results = []
  for (const scale of SCALES) {
    console.log(`[probe] 采样 scale=${scale} …`)
    results.push(await runScale(scale))
  }

  const { ok, text } = summarize(results)
  console.log(`\n${text}`)
  process.exit(ok ? 0 : 1)
}

// 只有直接运行时才跑主流程（被测试 import 时不启动 Electron）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('[probe] 运行失败', err)
    process.exit(1)
  })
}
