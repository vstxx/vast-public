import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

async function source(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8')
}

test('extension IPC remains behind the trusted main-frame sender guard and native folder picker', async () => {
  const [ipc, extensionIpc] = await Promise.all([
    source('src/main/ipc.ts'),
    source('src/main/ipc/extensions.ts')
  ])

  assert.match(ipc, /registerExtensionsIpc\(handle, senderWindowFor, extensionManager\)/)
  assert.match(ipc, /event\.senderFrame !== event\.sender\.mainFrame/)
  assert.match(ipc, /isTrustedRendererUrl\(event\.senderFrame\.url\)/)
  assert.match(extensionIpc, /dialog\.showOpenDialog/)
  assert.match(extensionIpc, /properties:\s*\['openDirectory', 'dontAddToRecent'\]/)
  assert.doesNotMatch(extensionIpc, /loadUnpacked[^]*args\.path/)
})

test('preload exposes only narrow extension operations and no raw filesystem or Session objects', async () => {
  const preload = await source('src/preload/index.ts')
  const extensionStart = preload.indexOf('  extensions: {')
  const extensionEnd = preload.indexOf('\n  privacy:', extensionStart)
  assert.ok(extensionStart >= 0 && extensionEnd > extensionStart, 'extension preload bridge must remain a dedicated API section')
  const extensionBridge = preload.slice(extensionStart, extensionEnd)

  for (const operation of ['list', 'loadUnpacked', 'enable', 'disable', 'reload', 'remove', 'prepareSurface', 'onChanged']) {
    assert.match(extensionBridge, new RegExp(`${operation}:`))
  }
  assert.doesNotMatch(extensionBridge, /require\(|readFile|writeFile|fromPartition|loadExtension/)
})

test('extensions are wired to website partitions while Vast UI and private partitions stay excluded', async () => {
  const [main, sessions, manager] = await Promise.all([
    source('src/main/main.ts'),
    source('src/main/sessions.ts'),
    source('src/main/extensions/extension-manager.ts')
  ])

  assert.match(main, /sessionProvider:\s*\(partition\)\s*=>\s*session\.fromPartition\(partition\)/)
  assert.doesNotMatch(main, /defaultSession\.extensions\.loadExtension/)
  assert.match(sessions, /will-attach-webview/)
  assert.match(sessions, /ensureForPartition\(partition\)/)
  assert.match(sessions, /extensionSurfaceCandidate/)
  assert.match(sessions, /authorizeSurfaceAttachment\(src, partition\)/)
  assert.match(manager, /this\.preparedSurfaces\.delete\(key\)/)
  assert.match(manager, /this\.surfaceTokens\.delete\(token\)/)
  assert.match(manager, /isAllowedSurfaceNavigation/)
  assert.match(manager, /if \(workspace\.isPrivate\) continue/)
  assert.match(manager, /identity\.sessionMode === 'ephemeral'/)
  assert.match(manager, /partition === 'persist:vast-default'/)
})

test('Extensions navigation is discoverable and the Reset zoom menu row is absent', async () => {
  const [addressBar, router, constants] = await Promise.all([
    source('src/renderer/components/browser/AddressBar.tsx'),
    source('src/renderer/components/browser/InternalPageRouter.tsx'),
    source('src/shared/constants.ts')
  ])

  assert.match(addressBar, /label="Extensions"/)
  assert.doesNotMatch(addressBar, /label="Reset zoom"/)
  assert.match(router, /ExtensionsPage/)
  assert.match(router, /INTERNAL_EXTENSIONS_URL/)
  assert.match(constants, /vast:\/\/extensions/)
})
