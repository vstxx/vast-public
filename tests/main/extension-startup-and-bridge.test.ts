import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/main/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const main = read('main.ts')
const sessions = read('sessions.ts')
const manager = read('extensions/extension-manager.ts')
const bridge = read('extensions/extension-network-bridge.ts')

test('the window opens while extensions are restored; tab requests wait for them', () => {
  assert.doesNotMatch(main, /await extensionManager\.initialize\(/)
  assert.match(main, /const extensionsRestored = extensionManager\.initialize\(startupData\.workspaces\)/)
  assert.match(main, /holdTabRequestsUntil\(extensionsRestored\)/)
  assert.ok(main.indexOf('holdTabRequestsUntil(extensionsRestored)') < main.indexOf("kind: 'primary'"), 'the hold is in place before the primary window exists')
  // Only web requests from tab webviews wait, never longer than the cap.
  assert.match(sessions, /export function holdTabRequestsUntil\(ready: Promise<unknown>, maxMs = 15_000\)/)
  assert.match(sessions, /return webContents\.fromId\(details\.webContentsId\)\?\.getType\(\) === 'webview'/)
  assert.match(sessions, /if \(heldUntilExtensionsReady\(details\)\) \{\n\s*void tabRequestHold!\.then\(\(\) => onBeforeRequest\(details, callback\)\)/)
})

test('startup verifies each install once and loads workspaces in parallel', () => {
  assert.match(manager, /else verified\.set\(storedRecord\.id, legacyManifest\)/)
  assert.match(manager, /await this\.refreshRecord\(storedRecord, verified\.get\(storedRecord\.id\)\)/)
  assert.match(manager, /await Promise\.all\(remaining\.map\(loadInto\)\)/)
  // The first session still establishes the runtime ID the others are checked against.
  assert.match(manager, /while \(!record\.runtimeExtensionId && remaining\.length > 0\)/)
})

test('opening a tab does not re-validate extensions already running in its session', () => {
  assert.match(manager, /if \(loadedId && this\.sessions\.get\(partition\)\?\.extensions\.getExtension\(loadedId\)\) continue/)
})

test('the network bridge reads manifests once per provider, not per request', () => {
  const decision = bridge.slice(bridge.indexOf('export async function extensionNetworkDecision'))
  assert.doesNotMatch(decision, /getExtension|authority\(/)
  assert.match(decision, /if \(providers\.size === 0\) return \{\}/)
  assert.match(decision, /finish\(active\(provider\) \? sanitizeDecision\(result\) : \{\}\)/)
  // Revocation still applies: unloading the extension removes the provider.
  assert.match(bridge, /return !provider\.contents\.isDestroyed\(\) && providers\.get\(provider\.contents\.id\) === provider/)
  assert.match(bridge, /extension-unloaded[\s\S]{0,200}providers\.delete\(id\)/)
})
