import test from 'node:test'
import assert from 'node:assert/strict'
import { describeNetError } from '../src/main/poller-service.js'

/** undici 网络失败时真实原因包在 err.cause.code 里 */
function fetchFail(code) {
  const err = new TypeError('fetch failed')
  err.cause = { code }
  return err
}

test('describeNetError: EPERM → 提示本地网络权限（macOS 未签名应用常见问题）', () => {
  assert.match(describeNetError(fetchFail('EPERM')), /本地网络权限/)
})

test('describeNetError: 拒绝 / 超时 / 解析失败 / 重置各有专属提示', () => {
  assert.match(describeNetError(fetchFail('ECONNREFUSED')), /拒绝/)
  assert.match(describeNetError(fetchFail('ETIMEDOUT')), /超时/)
  assert.match(describeNetError(fetchFail('ENOTFOUND')), /无法解析/)
  assert.match(describeNetError(fetchFail('ECONNRESET')), /重置/)
})

test('describeNetError: 未知错误与空值回退"服务不可达"', () => {
  assert.equal(describeNetError(new Error('x')), '服务不可达')
  assert.equal(describeNetError(null), '服务不可达')
  assert.equal(describeNetError(undefined), '服务不可达')
})
