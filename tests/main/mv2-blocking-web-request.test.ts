import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { usesNativeBlockingWebRequest } from '../../src/main/extensions/extension-manifest.ts'

const manager = readFileSync(new URL('../../src/main/extensions/extension-manager.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const adblocker = JSON.parse(readFileSync(new URL('../../resources/first-party-extensions/adblocker-for-vast/manifest.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>
const background = { scripts: ['background.js'], persistent: true }

// On Electron 45 one native MV2 blocking listener stalled every page load.
test('ordinary MV2 extensions with blocking webRequest are not loaded natively', () => {
  assert.equal(usesNativeBlockingWebRequest({ manifest_version: 2, permissions: ['webRequest', 'webRequestBlocking', '<all_urls>'], background }), true)
  assert.equal(usesNativeBlockingWebRequest({ manifest_version: 2, permissions: ['webRequest', '<all_urls>'], background }), false)
  assert.equal(usesNativeBlockingWebRequest({ manifest_version: 2, permissions: ['storage'], background }), false)
  assert.equal(usesNativeBlockingWebRequest({ manifest_version: 3, permissions: ['webRequest'], background: { service_worker: 'sw.js' } }), false)
})

test('Vast network providers, including the bundled ad blocker, keep loading through the Vast bridge', () => {
  assert.equal(usesNativeBlockingWebRequest(adblocker), false)
})

test('the guard runs before the native extension load', () => {
  assert.match(manager, /if \(usesNativeBlockingWebRequest\(validated\.manifest[^)]*\)\) throw new Error\(NATIVE_BLOCKING_WEB_REQUEST_ERROR\)\n\s*const extension = await targetSession\.extensions\.loadExtension\(/)
})
