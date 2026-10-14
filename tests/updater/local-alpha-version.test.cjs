const test = require('node:test')
const assert = require('node:assert/strict')
const { packagedVersion } = require('../../scripts/local-alpha-version.cjs')

test('local alpha package version is isolated from the public source version', () => {
  assert.equal(packagedVersion('0.4.3', {}), '0.4.3')
  const env = { VAST_LOCAL_ALPHA_VERSION: '0.5.0-alpha.1', VAST_RELEASE_CHANNEL: 'alpha', VAST_PRIVATE_BUILD: '1', VAST_UPDATE_ENABLED: '0' }
  assert.equal(packagedVersion('0.4.3', env), '0.5.0-alpha.1')
  assert.throws(() => packagedVersion('0.4.3', { ...env, VAST_PRIVATE_BUILD: '0' }), /private/i)
  assert.throws(() => packagedVersion('0.4.3', { ...env, VAST_UPDATE_ENABLED: '1' }), /network updater/i)
  assert.throws(() => packagedVersion('0.4.3', { ...env, VAST_LOCAL_ALPHA_VERSION: '0.5.0' }), /alpha version/i)
})
