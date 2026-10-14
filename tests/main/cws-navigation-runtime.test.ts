import assert from 'node:assert/strict'
import test from 'node:test'
import { cwsNavigationGate } from '../../src/main/cws-navigation-runtime.ts'
import { configureChromeWebStoreNavigation, blockedTopLevelNavigationReplacement, routeTopLevelNavigationUrl } from '../../src/shared/top-level-navigation-policy.ts'

const listing = 'https://chromewebstore.google.com/detail/idu+/nckhacbgboonmhekihinhokldoogagoh'
const base = {
  isPackaged: false,
  electronVersion: '44.7.0',
  chromeVersion: '152.0.7977.130',
  executablePath: 'D:\\VastElectron44\\src\\out\\VastRelease\\electron.exe',
  binarySha256: 'a'.repeat(64),
  compatibilityEnabled: true,
  approvedRuntime: { electron: { version: '44.7.0', chromiumVersion: '152.0.7977.130', binary: { sha256: 'a'.repeat(64) } }, cws: { navigationApproved: false } },
  env: { VAST_PATCHED_ELECTRON_DIST: 'D:\\VastElectron44\\src\\out\\VastRelease' }
}

test('CWS navigation requires the approved executable and compatibility runtime', () => {
  assert.equal(cwsNavigationGate(base), true)
  assert.equal(cwsNavigationGate({ ...base, binarySha256: 'b'.repeat(64) }), false)
  assert.equal(cwsNavigationGate({ ...base, chromeVersion: '152.0.7977.129' }), false)
  assert.equal(cwsNavigationGate({ ...base, compatibilityEnabled: false }), false)
  assert.equal(cwsNavigationGate({ ...base, env: {} }), false)
  assert.equal(cwsNavigationGate({ ...base, env: { ...base.env, VAST_CWS_NAVIGATION_DISABLE: '1' } }), false)
  assert.equal(cwsNavigationGate({ ...base, executablePath: 'C:\\Other\\electron.exe' }), false)
})

test('packaged navigation stays guarded until approved in the manifest', () => {
  assert.equal(cwsNavigationGate({ ...base, isPackaged: true }), false)
  assert.equal(cwsNavigationGate({ ...base, isPackaged: true, approvedRuntime: { ...base.approvedRuntime, cws: { navigationApproved: true } } }), true)
})

test('the navigation policy switches both address routing and main request guard together', () => {
  assert.ok(blockedTopLevelNavigationReplacement(listing))
  try {
    configureChromeWebStoreNavigation(true)
    assert.equal(blockedTopLevelNavigationReplacement(listing), undefined)
    assert.equal(routeTopLevelNavigationUrl(listing), listing)
    assert.equal(routeTopLevelNavigationUrl('javascript:alert(1)'), 'javascript:alert(1)')
  } finally {
    configureChromeWebStoreNavigation(false)
  }
  assert.ok(blockedTopLevelNavigationReplacement(listing))
})
