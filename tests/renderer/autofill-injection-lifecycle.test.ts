import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const guestPreloadSource = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(
  new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url),
  'utf8'
)

test('repeated autofill configuration deterministically cleans up the previous document binding', () => {
  assert.match(guestPreloadSource, /function configureAutofill\(input: unknown\): void \{\s*cleanupAutofill\(\)/)
  assert.match(guestPreloadSource, /autofillObserver\?\.disconnect\(\)/)
  assert.match(guestPreloadSource, /autofillController\?\.abort\(\)/)
  assert.match(guestPreloadSource, /autofillRoot\?\.remove\(\)/)
  assert.match(guestPreloadSource, /autofillStyle\?\.remove\(\)/)
})

test('mutation processing is debounced and limited to added subtrees', () => {
  assert.match(guestPreloadSource, /mutation\.addedNodes/)
  assert.match(guestPreloadSource, /pendingAutofillRoots\.add\(node\)/)
  assert.match(guestPreloadSource, /window\.setTimeout\(flushChangedSubtrees, 80\)/)
  assert.match(guestPreloadSource, /for \(const changedRoot of roots\) scanSubtree\(changedRoot\)/)
  assert.doesNotMatch(guestPreloadSource, /new MutationObserver\(scanSubtree\)/)
})

test('late webview lifecycle events cannot send autofill config after detach', () => {
  assert.match(webviewSurfaceSource, /const sendToGuest = /)
  assert.match(webviewSurfaceSource, /!domReadyRef\.current \|\| !\(webview as HTMLElement\)\.isConnected/)
  assert.match(webviewSurfaceSource, /webview\.send\(channel, payload\)/)
  assert.doesNotMatch(webviewSurfaceSource, /webview\.send\('vast:password-(?:autofill|capture)-config'/)
})
