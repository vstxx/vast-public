const test = require('node:test')
const assert = require('node:assert/strict')
const { createPreflightEnvironment } = require('../../scripts/release-preflight-environment.cjs')

test('local development preflight cannot consume stale release provenance', () => {
  const parent = {
    VAST_RELEASE_COMMIT: 'a'.repeat(40),
    VAST_EXTENSION_COMPATIBILITY_FINGERPRINT_REQUIRED: '1',
    VAST_PATCHED_ELECTRON_DIST: 'D:\\approved-electron',
    ELECTRON_RUN_AS_NODE: '1'
  }
  const env = createPreflightEnvironment(parent)
  assert.equal(env.VAST_RELEASE_COMMIT, undefined)
  assert.equal(env.VAST_EXTENSION_COMPATIBILITY_FINGERPRINT_REQUIRED, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.VAST_PATCHED_ELECTRON_DIST, parent.VAST_PATCHED_ELECTRON_DIST)
  assert.equal(env.VAST_RELEASE_CHANNEL, 'dev')
  assert.equal(env.VAST_PRIVATE_BUILD, '1')
  assert.equal(parent.VAST_RELEASE_COMMIT, 'a'.repeat(40))
})
