/**
 * update-core.js — 自我更新的纯逻辑（零依赖，浏览器/Node 通用，便于单测）
 *
 * 发布物命名约定（见 .github/workflows/release.yml）：
 *   vllm-pet-<ver>-arm64-mac.zip / vllm-pet-<ver>-mac.zip
 *   vllm-pet.Setup.<ver>.exe
 *   vllm-pet-<ver>[.arm64].AppImage / vllm-pet_<ver>_<arch>.deb
 */

export const UPDATE_REPO = 'bzdbzdbzd121/vllm-pet'

/** GitHub API：最新 Release（可用 VLLM_PET_UPDATE_API 覆盖做联调） */
export function releasesApiUrl(repo = UPDATE_REPO) {
  return `https://api.github.com/repos/${repo}/releases/latest`
}

/** Release 网页地址（手动下载兜底） */
export function releasePageUrl(repo = UPDATE_REPO) {
  return `https://github.com/${repo}/releases/latest`
}

/**
 * 解析版本号为 [major, minor, patch]。允许前导 v 与后缀（如 0.1.2-beta 只取前三段）。
 * @returns {[number, number, number]|null}
 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** latest 是否比 current 新（任一解析失败 → false） */
export function isNewerVersion(latest, current) {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/**
 * 从 GitHub Release JSON 提取更新信息。
 * @returns {{ version: string, tag: string, notes: string, pageUrl: string,
 *             assets: Array<{ name: string, url: string, size: number }> }|null}
 */
export function parseRelease(json) {
  if (!json || typeof json !== 'object') return null
  const tag = typeof json.tag_name === 'string' ? json.tag_name : ''
  const version = parseVersion(tag)?.join('.')
  if (!version) return null
  const assets = Array.isArray(json.assets)
    ? json.assets
        .filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
        .map((a) => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }))
    : []
  return {
    version,
    tag,
    notes: typeof json.body === 'string' ? json.body : '',
    pageUrl: typeof json.html_url === 'string' ? json.html_url : releasePageUrl(),
    assets
  }
}

/**
 * 按平台/架构从资产列表挑选下载包。
 * macOS 选自更新用的 zip；Windows 选 NSIS 安装包；Linux 选 AppImage。
 * @returns {{ name: string, url: string, size: number }|null}
 */
export function pickAsset(assets, platform, arch) {
  if (!Array.isArray(assets)) return null
  const find = (pred) => assets.find((a) => a && typeof a.name === 'string' && pred(a.name)) || null
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? find((n) => n.endsWith('-arm64-mac.zip'))
      : find((n) => n.endsWith('-mac.zip') && !n.includes('arm64'))
  }
  if (platform === 'win32') {
    return find((n) => n.endsWith('.exe') && /setup/i.test(n)) || find((n) => n.endsWith('.exe'))
  }
  if (platform === 'linux') {
    return arch === 'arm64'
      ? find((n) => n.endsWith('.AppImage') && n.includes('arm64'))
      : find((n) => n.endsWith('.AppImage') && !n.includes('arm64'))
  }
  return null
}

/**
 * 生成"等旧进程退出 → 备份旧包 → 换入新包 → 去隔离 → 重启"的 POSIX sh 脚本。
 * 参数：$1=旧进程 PID  $2=目标路径  $3=新文件路径  $4=备份路径
 * 任何一步失败都保持现场可恢复（备份仍在）。
 * @param {{ relaunch?: 'open'|'direct' }} [opts]
 *   open   — macOS：xattr 去隔离 + open -n（用于 .app 包）
 *   direct — Linux：chmod +x 后直接执行（用于 AppImage）
 */
export function buildApplyScript({ relaunch = 'open' } = {}) {
  const relaunchLines =
    relaunch === 'direct'
      ? ['  chmod +x "$BUNDLE" 2>/dev/null', '  "$BUNDLE" &']
      : ['  xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null', '  open -n "$BUNDLE"']
  return [
    '#!/bin/sh',
    'PID="$1"; BUNDLE="$2"; NEW_APP="$3"; BACKUP="$4"',
    '# 等旧进程完全退出',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    'sleep 1',
    'mv "$BUNDLE" "$BACKUP" || exit 1',
    'if mv "$NEW_APP" "$BUNDLE"; then',
    ...relaunchLines,
    'else',
    '  mv "$BACKUP" "$BUNDLE" # 换入失败则回滚',
    'fi',
    'exit 0',
    ''
  ].join('\n')
}

/**
 * Windows 自更新守护脚本（cmd）：等旧进程退出 → NSIS 静默安装 → 启动新版。
 * 路径与 PID 直接内联（避免 cmd 参数引号转义坑）；静默安装会读取注册表中
 * 原安装目录，因此升级覆盖到原位置。若安装器自带结束后启动，重复 start 会被
 * 单实例锁挡掉，无副作用。
 */
export function buildWindowsApplyScript({ pid, setupPath, targetExe }) {
  return [
    '@echo off',
    `set "PID=${pid}"`,
    `set "SETUP=${setupPath}"`,
    `set "TARGET=${targetExe}"`,
    ':wait',
    'tasklist /FI "PID eq %PID%" /NH 2>nul | find /I ".exe" >nul',
    'if %errorlevel% equ 0 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    '"%SETUP%" /S',
    'start "" "%TARGET%"',
    'exit',
    ''
  ].join('\r\n')
}
