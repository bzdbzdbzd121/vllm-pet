import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { downloadFile, extractZip, findAppBundle } from '../src/main/download.js'

/** 起个本地 HTTP 服务，返回指定内容 */
function serveOnce(body, { status = 200, headers = {} } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(status, headers)
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

test('downloadFile: 下载完整且进度回调递增', async (t) => {
  const payload = crypto.randomBytes(256 * 1024) // 256KB
  const { server, url } = await serveOnce(payload, {
    headers: { 'content-length': String(payload.length) }
  })
  t.after(() => server.close())

  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'f.bin')
  const progress = []
  const n = await downloadFile(url, dest, (received, total) => progress.push([received, total]))

  assert.equal(n, payload.length)
  assert.deepEqual(fs.readFileSync(dest), payload)
  assert.ok(progress.length > 1, '应多次回调进度')
  assert.equal(progress.at(-1)[0], payload.length)
  assert.equal(progress.at(-1)[1], payload.length)
  // 进度单调递增
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0])
})

test('downloadFile: HTTP 错误抛异常且不留下完整假象', async (t) => {
  const { server, url } = await serveOnce('nope', { status: 404 })
  t.after(() => server.close())
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'f.bin')
  await assert.rejects(() => downloadFile(url, dest), /HTTP 404/)
  assert.equal(fs.existsSync(dest), false)
})

const HAS_DITTO = process.platform === 'darwin'

test('extractZip + findAppBundle: 解压并定位 .app', { skip: !HAS_DITTO && '仅 macOS（ditto）验证' }, async (t) => {
  // 造一个最小 .app 结构打成 zip
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'))
  const appDir = path.join(tmp, 'vllm-pet.app', 'Contents')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'Info.plist'), '<plist/>')
  const zipPath = path.join(tmp, 'app.zip')
  const { execFileSync } = await import('node:child_process')
  execFileSync('ditto', ['-ck', '--keepParent', `${tmp}/vllm-pet.app`, zipPath])

  const extractDir = path.join(tmp, 'out')
  await extractZip(zipPath, extractDir)
  const bundle = findAppBundle(extractDir)
  assert.ok(bundle?.endsWith('vllm-pet.app'))
  assert.ok(fs.existsSync(path.join(bundle, 'Contents', 'Info.plist')))
})
