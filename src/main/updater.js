/**
 * updater.js — 应用内自我更新
 *
 * 为什么不用 electron-updater：macOS 上它强制要求 Apple 开发者签名；
 * 而程序内通过 fetch 下载的文件不会被打 quarantine 标记，未签名包也能顺畅自更新。
 *
 * 各平台方案：
 *   macOS（.app）       — 下载 zip → ditto 解压 → 守护脚本换包（旧包入废纸篓）→ 重启
 *   Windows（NSIS 安装版）— 下载 Setup.exe → cmd 守护脚本等退出后 /S 静默覆盖 → 启动新版
 *   Linux（AppImage）    — 下载新 AppImage 到同目录 .new → 守护脚本换文件（.old 备份）→ 重启
 *   其他（deb / 便携版 / 开发模式 / 无写权限）— 自动降级为跳 Release 页手动更新
 */
import { app, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  UPDATE_REPO,
  releasesApiUrl,
  releasePageUrl,
  isNewerVersion,
  parseRelease,
  pickAsset,
  buildApplyScript,
  buildWindowsApplyScript
} from '../shared/update-core.js'
import { downloadFile, extractZip, findAppBundle } from './download.js'

const CHECK_TIMEOUT_MS = 8000

export class UpdateService {
  /**
   * @param {{
   *   repo?: string,
   *   getVersion?: () => string,
   *   getAutoCheck?: () => boolean,
   *   onProgress?: (text: string) => void,
   *   parentWindow?: () => import('electron').BrowserWindow|null
   * }} opts
   */
  constructor({ repo = UPDATE_REPO, getVersion, getAutoCheck, onProgress, parentWindow } = {}) {
    this.repo = repo
    this.getVersion = getVersion || (() => app.getVersion())
    this.getAutoCheck = getAutoCheck || (() => true)
    this.onProgress = onProgress || (() => {})
    this.parentWindow = parentWindow || (() => null)
    this._busy = false
  }

  /** 启动后延时自动检查（静默：无更新/失败都不打扰） */
  scheduleAutoCheck(delayMs = 6000) {
    setTimeout(() => {
      if (this.getAutoCheck()) this.check({ manual: false }).catch(() => {})
    }, delayMs)
  }

  /**
   * 检查更新主流程。manual=true 时反馈所有结果（包括"已是最新"和失败原因）。
   * @returns {Promise<{ hasUpdate: boolean, version?: string }>}
   */
  async check({ manual = false } = {}) {
    if (this._busy) return { hasUpdate: false }
    this._busy = true
    try {
      const release = await this._fetchLatest()
      if (!release) {
        if (manual) await this._info('检查更新失败', '无法获取最新版本信息，请稍后再试。', true)
        return { hasUpdate: false }
      }
      const current = this.getVersion()
      if (!isNewerVersion(release.version, current)) {
        if (manual) await this._info('已是最新', `当前版本 v${current} 已是最新版本。`)
        return { hasUpdate: false }
      }

      const target = this._installTarget()
      const canAutoInstall = !!target && !!pickAsset(release.assets, process.platform, process.arch)
      const notes = release.notes.trim().slice(0, 400)
      const detail = `当前版本：v${current}\n最新版本：v${release.version}${notes ? `\n\n${notes}` : ''}`

      if (canAutoInstall) {
        const choice = await this._ask(`发现新版本 v${release.version}`, detail, ['立即更新', '稍后提醒', '查看发布页'])
        if (choice === 2) await shell.openExternal(release.pageUrl)
        else if (choice === 0) await this._downloadAndInstall(release)
      } else {
        const choice = await this._ask(
          `发现新版本 v${release.version}`,
          `${detail}\n\n请前往发布页下载安装。`,
          ['前往下载', '稍后提醒']
        )
        if (choice === 0) await shell.openExternal(release.pageUrl)
      }
      return { hasUpdate: true, version: release.version }
    } catch (err) {
      if (manual) await this._info('检查更新失败', String(err?.message || err), true)
      return { hasUpdate: false }
    } finally {
      this._busy = false
      this.onProgress('')
    }
  }

  /** 拉取最新 Release 并解析；失败返回 null */
  async _fetchLatest() {
    const api = process.env.VLLM_PET_UPDATE_API || releasesApiUrl(this.repo)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS)
    try {
      const res = await fetch(api, {
        headers: { 'User-Agent': 'vllm-pet-updater', Accept: 'application/vnd.github+json' },
        signal: ctrl.signal
      })
      if (!res.ok) return null
      return parseRelease(await res.json())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 当前安装形态与可替换目标；不可自更新（开发模式 / Windows 便携版 / 系统包装如 deb）返回 null
   * @returns {{ kind: 'mac-app'|'win-nsis'|'linux-appimage', path: string }|null}
   */
  _installTarget() {
    const exe = app.getPath('exe')
    if (process.platform === 'darwin') {
      const m = /^(.+?\.app)\//.exec(exe + '/')
      // 只替换自己的名字，避免误伤（开发模式下是 Electron.app）
      if (m && /vllm-pet/i.test(path.basename(m[1]))) return { kind: 'mac-app', path: m[1] }
      return null
    }
    if (process.platform === 'win32') {
      // NSIS 默认装在 ...\Programs\vllm-pet\vllm-pet.exe；便携版文件名带版本号，排除
      return /^vllm-pet\.exe$/i.test(path.basename(exe)) ? { kind: 'win-nsis', path: exe } : null
    }
    if (process.platform === 'linux') {
      return exe.endsWith('.AppImage') ? { kind: 'linux-appimage', path: exe } : null
    }
    return null
  }

  /** 下载 → 按平台布置更新 → 提示重启（立即或下次退出时生效） */
  async _downloadAndInstall(release) {
    const target = this._installTarget()
    const asset = target && pickAsset(release.assets, process.platform, process.arch)
    if (!target || !asset) {
      await this._info('无法自动更新', '当前环境不支持自动更新，请前往发布页手动下载。', true)
      await shell.openExternal(release.pageUrl)
      return
    }
    try {
      fs.accessSync(target.path, fs.constants.W_OK)
      fs.accessSync(path.dirname(target.path), fs.constants.W_OK)
    } catch {
      const choice = await this._ask(
        '没有写入权限',
        `无法写入 ${target.path}，请手动下载安装新版本。`,
        ['前往下载', '取消']
      )
      if (choice === 0) await shell.openExternal(release.pageUrl)
      return
    }

    // 下载（AppImage 直接落到目标同目录，保证 mv 不跨文件系统）
    const updateDir = path.join(app.getPath('userData'), 'update')
    const ext = { 'mac-app': 'zip', 'win-nsis': 'exe', 'linux-appimage': 'AppImage' }[target.kind]
    const pkgPath =
      target.kind === 'linux-appimage'
        ? `${target.path}.new`
        : path.join(updateDir, `vllm-pet-${release.version}.${ext}`)
    this.onProgress(`正在下载 v${release.version}…`)
    try {
      await downloadFile(asset.url, pkgPath, (received, total) => {
        this.onProgress(
          total > 0
            ? `正在下载 v${release.version} ${Math.round((received / total) * 100)}%`
            : `正在下载 v${release.version} ${(received / 1024 / 1024).toFixed(0)}MB`
        )
      })
    } catch (err) {
      await this._info('下载失败', `${String(err?.message || err)}\n\n可前往发布页手动下载。`, true)
      return
    }

    try {
      if (target.kind === 'mac-app') await this._stageMac(release, pkgPath, target.path)
      else if (target.kind === 'win-nsis') this._stageWindows(release, pkgPath, target.path)
      else this._stageAppImage(release, pkgPath, target.path)
    } catch (err) {
      await this._info('更新准备失败', `${String(err?.message || err)}\n\n可前往发布页手动下载。`, true)
      return
    }

    const choice = await this._ask(
      '下载完成',
      `v${release.version} 已就绪。\n\n立即重启：现在退出并完成更新。\n稍后：下次退出小V时自动完成更新并重新启动。`,
      ['立即重启', '稍后']
    )
    if (choice === 0) app.quit()
    else this.onProgress('')
  }

  /** macOS：解压 zip → 守护脚本换包（旧包入废纸篓）→ 重启 */
  async _stageMac(release, zipPath, bundle) {
    this.onProgress('正在解压…')
    const updateDir = path.join(app.getPath('userData'), 'update')
    const extractDir = path.join(updateDir, 'extract')
    await extractZip(zipPath, extractDir)
    const newApp = findAppBundle(extractDir)
    if (!newApp || !fs.existsSync(path.join(newApp, 'Contents', 'Info.plist'))) {
      throw new Error('安装包内容不完整')
    }
    const backup = path.join(os.homedir(), '.Trash', `vllm-pet-${this.getVersion()}-${Date.now()}.app`)
    const scriptPath = path.join(updateDir, 'apply-update.sh')
    fs.writeFileSync(scriptPath, buildApplyScript({ relaunch: 'open' }), { mode: 0o755 })
    this._spawnHelper('/bin/sh', [scriptPath, String(process.pid), bundle, newApp, backup])
  }

  /** Windows：校验 exe → cmd 守护脚本（等退出 → NSIS /S 静默覆盖 → 启动新版） */
  _stageWindows(release, setupPath, targetExe) {
    const fd = fs.openSync(setupPath, 'r')
    const magic = Buffer.alloc(2)
    fs.readSync(fd, magic, 0, 2, 0)
    fs.closeSync(fd)
    if (magic.toString('latin1') !== 'MZ') throw new Error('安装包损坏（非可执行文件）')
    const scriptPath = path.join(app.getPath('userData'), 'update', 'apply-update.cmd')
    fs.writeFileSync(
      scriptPath,
      buildWindowsApplyScript({ pid: process.pid, setupPath, targetExe })
    )
    this._spawnHelper('cmd.exe', ['/c', scriptPath], { windowsHide: true })
  }

  /** Linux AppImage：守护脚本同目录换文件（.old 备份）→ 重启 */
  _stageAppImage(release, stagedPath, targetPath) {
    fs.chmodSync(stagedPath, 0o755)
    const backup = `${targetPath}.old-${Date.now()}`
    const scriptPath = path.join(app.getPath('userData'), 'update', 'apply-update.sh')
    fs.writeFileSync(scriptPath, buildApplyScript({ relaunch: 'direct' }), { mode: 0o755 })
    this._spawnHelper('/bin/sh', [scriptPath, String(process.pid), targetPath, stagedPath, backup])
  }

  _spawnHelper(cmd, args, extra = {}) {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...extra })
    child.unref()
  }

  _ask(message, detail, buttons) {
    return dialog
      .showMessageBox(this.parentWindow() || undefined, {
        type: 'info',
        message,
        detail,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true
      })
      .then((r) => r.response)
  }

  _info(message, detail, isError = false) {
    return dialog.showMessageBox(this.parentWindow() || undefined, {
      type: isError ? 'warning' : 'info',
      message,
      detail,
      buttons: ['好'],
      noLink: true
    })
  }
}

export { releasePageUrl }
