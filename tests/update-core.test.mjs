import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  isNewerVersion,
  parseRelease,
  pickAsset,
  buildApplyScript,
  buildWindowsApplyScript,
  releasesApiUrl,
  releasePageUrl
} from '../src/shared/update-core.js'

// 取自 v0.1.2 真实 Release 资产列表
const ASSETS = [
  'vllm-pet-0.1.2-arm64-mac.zip',
  'vllm-pet-0.1.2-arm64.AppImage',
  'vllm-pet-0.1.2-arm64.dmg',
  'vllm-pet-0.1.2-mac.zip',
  'vllm-pet-0.1.2.AppImage',
  'vllm-pet-0.1.2.dmg',
  'vllm-pet.0.1.2.exe',
  'vllm-pet.Setup.0.1.2.exe',
  'vllm-pet_0.1.2_amd64.deb',
  'vllm-pet_0.1.2_arm64.deb'
].map((name) => ({ name, browser_download_url: `https://example.com/${name}`, size: 1000 }))

test('parseVersion: 常规与前导 v', () => {
  assert.deepEqual(parseVersion('0.1.2'), [0, 1, 2])
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('v0.1.10-beta'), [0, 1, 10])
  assert.equal(parseVersion('abc'), null)
  assert.equal(parseVersion('1.2'), null)
  assert.equal(parseVersion(null), null)
})

test('isNewerVersion: 比较规则', () => {
  assert.equal(isNewerVersion('v0.1.3', '0.1.2'), true)
  assert.equal(isNewerVersion('0.1.2', 'v0.1.2'), false)
  assert.equal(isNewerVersion('0.1.10', '0.1.9'), true) // 数字比较而非字符串比较
  assert.equal(isNewerVersion('0.1.2', '0.2.0'), false)
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true)
  assert.equal(isNewerVersion('bad', '0.1.2'), false)
})

test('parseRelease: 提取版本/说明/资产', () => {
  const r = parseRelease({
    tag_name: 'v0.1.2',
    body: '一些更新说明',
    html_url: 'https://github.com/x/releases/tag/v0.1.2',
    assets: ASSETS.map((a) => ({ name: a.name, browser_download_url: a.browser_download_url, size: 1000 }))
  })
  assert.equal(r.version, '0.1.2')
  assert.equal(r.tag, 'v0.1.2')
  assert.equal(r.notes, '一些更新说明')
  assert.equal(r.assets.length, 10)
  assert.equal(parseRelease({}), null)
  assert.equal(parseRelease({ tag_name: 'not-a-version' }), null)
})

test('pickAsset: macOS 按架构选 zip', () => {
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64')?.name, 'vllm-pet-0.1.2-arm64-mac.zip')
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64')?.name, 'vllm-pet-0.1.2-mac.zip')
})

test('pickAsset: Windows 选 NSIS 安装包，Linux 按架构选 AppImage', () => {
  assert.equal(pickAsset(ASSETS, 'win32', 'x64')?.name, 'vllm-pet.Setup.0.1.2.exe')
  assert.equal(pickAsset(ASSETS, 'linux', 'x64')?.name, 'vllm-pet-0.1.2.AppImage')
  assert.equal(pickAsset(ASSETS, 'linux', 'arm64')?.name, 'vllm-pet-0.1.2-arm64.AppImage')
  assert.equal(pickAsset([], 'darwin', 'arm64'), null)
  assert.equal(pickAsset(null, 'darwin', 'arm64'), null)
})

test('buildApplyScript: 守护脚本包含关键步骤', () => {
  const sh = buildApplyScript()
  assert.match(sh, /kill -0 "\$PID"/) // 等旧进程退出
  assert.match(sh, /mv "\$BUNDLE" "\$BACKUP"/) // 备份旧包
  assert.match(sh, /mv "\$NEW_APP" "\$BUNDLE"/) // 换入新包
  assert.match(sh, /xattr -dr com\.apple\.quarantine/) // 兜底去隔离
  assert.match(sh, /open -n "\$BUNDLE"/) // 重启
})

test('buildApplyScript(direct): AppImage 模式直接执行且不去隔离', () => {
  const sh = buildApplyScript({ relaunch: 'direct' })
  assert.match(sh, /chmod \+x "\$BUNDLE"/)
  assert.match(sh, /"\$BUNDLE" &/) // 后台直接启动
  assert.doesNotMatch(sh, /xattr/)
  assert.match(sh, /mv "\$BACKUP" "\$BUNDLE"/) // 回滚仍在
})

test('buildWindowsApplyScript: cmd 守护脚本等退出后静默安装并启动', () => {
  const cmd = buildWindowsApplyScript({
    pid: 1234,
    setupPath: 'C:\\Users\\a\\AppData\\Roaming\\vllm-pet\\update\\Setup.exe',
    targetExe: 'C:\\Users\\a\\AppData\\Local\\Programs\\vllm-pet\\vllm-pet.exe'
  })
  assert.match(cmd, /PID eq %PID%/) // 轮询旧进程
  assert.match(cmd, /1234/)
  assert.match(cmd, /"%SETUP%" \/S/) // NSIS 静默安装
  assert.match(cmd, /start "" "%TARGET%"/) // 启动新版
  assert.match(cmd, /\r\n/) // cmd 需要 CRLF
})

test('URL 常量', () => {
  assert.match(releasesApiUrl(), /^https:\/\/api\.github\.com\/repos\/.+\/releases\/latest$/)
  assert.match(releasePageUrl(), /^https:\/\/github\.com\/.+\/releases\/latest$/)
})
