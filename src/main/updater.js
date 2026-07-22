/**
 * updater.js — 应用内自我更新（macOS 一键；Windows/Linux 跳 Release 页手动更新）
 *
 * 为什么不用 electron-updater：macOS 上它强制要求 Apple 开发者签名；
 * 而程序内通过 fetch 下载的文件不会被打 quarantine 标记，未签名包也能顺畅自更新。
 *
 * 流程：GitHub API 查 latest Release → 版本比较 → 用户确认 → 下载 mac.zip 到
 * userData/update → ditto 解压 → 生成守护脚本（等本进程退出 → 旧包移入废纸篓
 * → 新包就位 → 去隔离 → 重启）→ 用户选择立即重启或下次退出时生效。
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
  buildApplyScript
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

      const canAutoInstall = process.platform === 'darwin' && !!pickAsset(release.assets, 'darwin', process.arch)
      const notes = release.notes.trim().slice(0, 400)
      const detail = `当前版本：v${current}\n最新版本：v${release.version}${notes ? `\n\n${notes}` : ''}`

      if (canAutoInstall && this._appBundlePath()) {
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

  /** 当前运行位置所属的 .app 包路径；不在 .app 内（开发模式）返回 null */
  _appBundlePath() {
    const m = /^(.+?\.app)\//.exec(app.getPath('exe') + '/')
    if (!m) return null
    const bundle = m[1]
    // 只替换自己的名字，避免误伤（开发模式下是 Electron.app）
    return /vllm-pet/i.test(path.basename(bundle)) ? bundle : null
  }

  /** macOS：下载 → 解压 → 布置守护脚本 → 提示重启 */
  async _downloadAndInstall(release) {
    const asset = pickAsset(release.assets, 'darwin', process.arch)
    if (!asset) throw new Error('未找到适用于本机的安装包')

    const bundle = this._appBundlePath()
    if (!bundle) {
      await this._info('无法自动更新', '当前并非从安装包运行（开发模式），请前往发布页手动下载。', true)
      await shell.openExternal(release.pageUrl)
      return
    }
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
      fs.accessSync(bundle, fs.constants.W_OK)
    } catch {
      const choice = await this._ask(
        '没有写入权限',
        `无法写入 ${bundle}，请手动下载安装新版本。`,
        ['前往下载', '取消']
      )
      if (choice === 0) await shell.openExternal(release.pageUrl)
      return
    }

    const updateDir = path.join(app.getPath('userData'), 'update')
    const zipPath = path.join(updateDir, `vllm-pet-${release.version}-mac.zip`)
    this.onProgress(`正在下载 v${release.version}…`)
    try {
      await downloadFile(asset.url, zipPath, (received, total) => {
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

    this.onProgress('正在解压…')
    let newApp
    try {
      const extractDir = path.join(updateDir, 'extract')
      await extractZip(zipPath, extractDir)
      newApp = findAppBundle(extractDir)
      if (!newApp || !fs.existsSync(path.join(newApp, 'Contents', 'Info.plist'))) {
        throw new Error('安装包内容不完整')
      }
    } catch (err) {
      await this._info('解压失败', String(err?.message || err), true)
      return
    }

    // 守护脚本：等本进程退出后完成替换并重启；旧包移入废纸篓可恢复
    const backup = path.join(os.homedir(), '.Trash', `vllm-pet-${this.getVersion()}-${Date.now()}.app`)
    const scriptPath = path.join(updateDir, 'apply-update.sh')
    fs.writeFileSync(scriptPath, buildApplyScript(), { mode: 0o755 })

    const choice = await this._ask(
      '下载完成',
      `v${release.version} 已就绪。\n\n立即重启：现在退出并完成更新。\n稍后：下次退出小V时自动完成更新并重新启动。`,
      ['立即重启', '稍后']
    )
    const child = spawn('/bin/sh', [scriptPath, String(process.pid), bundle, newApp, backup], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    if (choice === 0) app.quit()
    else this.onProgress('')
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
