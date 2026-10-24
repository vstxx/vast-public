import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cwsNavigationGate } from '../../src/main/cws-navigation-runtime.ts'
import { configureChromeWebStoreNavigation, blockedTopLevelNavigationReplacement, routeTopLevelNavigationUrl } from '../../src/shared/top-level-navigation-policy.ts'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const cwsApproval = JSON.parse(readFileSync(new URL('../../patches/cws-navigation-approval.json', import.meta.url), 'utf8')) as { navigationApproved?: boolean }
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

// 0.5.0 shipped with the store guarded. The packaged executable is rewritten
// by electron-builder and the fuses, so it is never hashed against the raw
// binary; the packaged compatibility attestation covers the binary instead.
test('an approved packaged build opens the store without hashing its rewritten executable', () => {
  const packaged = { ...base, isPackaged: true, binarySha256: '', executablePath: 'C:\\Program Files\\Vast\\Vast.exe', env: {}, approvedRuntime: { ...base.approvedRuntime, cws: { navigationApproved: true } } }
  assert.equal(cwsNavigationGate(packaged), true)
  assert.equal(cwsNavigationGate({ ...packaged, compatibilityEnabled: false }), false)
  assert.equal(cwsNavigationGate({ ...packaged, electronVersion: '44.6.0' }), false)
  assert.equal(cwsNavigationGate({ ...packaged, env: { VAST_CWS_NAVIGATION_DISABLE: '1' } }), false)
  assert.match(mainSource, /const cwsNavigationCandidate = compatibilityGate\.enabled && !app\.isPackaged/)
})

test('the release approves Chrome Web Store navigation for the verified runtime', () => {
  assert.equal(cwsApproval.navigationApproved, true)
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
