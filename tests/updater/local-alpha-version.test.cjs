const test = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULT_LOCAL_ALPHA_VERSION, packagedVersion } = require('../../scripts/local-alpha-version.cjs')

test('local alpha package version is isolated from the public source version', () => {
  assert.equal(packagedVersion('0.5.5', {}), '0.5.5')
  const env = { VAST_LOCAL_ALPHA_VERSION: '0.6.0', VAST_RELEASE_CHANNEL: 'alpha', VAST_PRIVATE_BUILD: '1', VAST_UPDATE_ENABLED: '0' }
  assert.equal(packagedVersion('0.5.5', env), '0.6.0')
  assert.equal(packagedVersion('0.5.5', { ...env, VAST_LOCAL_ALPHA_VERSION: '0.6.0-alpha.2' }), '0.6.0-alpha.2')
  assert.throws(() => packagedVersion('0.5.5', { ...env, VAST_PRIVATE_BUILD: '0' }), /private/i)
  assert.throws(() => packagedVersion('0.5.5', { ...env, VAST_UPDATE_ENABLED: '1' }), /network updater/i)
  assert.throws(() => packagedVersion('0.5.5', { ...env, VAST_LOCAL_ALPHA_VERSION: '0.6.0-beta.1' }), /alpha version/i)
  // A private build can never claim the current or an older public version.
  assert.throws(() => packagedVersion('0.5.5', { ...env, VAST_LOCAL_ALPHA_VERSION: '0.5.5' }), /newer than the source/i)
  assert.throws(() => packagedVersion('0.6.0', env), /newer than the source/i)
})

test('the default local alpha version is newer than the source version', () => {
  const { version } = require('../../package.json')
  assert.doesNotThrow(() => packagedVersion(version, { VAST_LOCAL_ALPHA_VERSION: DEFAULT_LOCAL_ALPHA_VERSION, VAST_RELEASE_CHANNEL: 'alpha', VAST_PRIVATE_BUILD: '1', VAST_UPDATE_ENABLED: '0' }))
})
