import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { ExtensionManager, extensionPartitionsForWorkspaces, isEligibleExtensionPartition } from '../../src/main/extensions/extension-manager.ts'
import { chromeExtensionId, validateExtensionManifest } from '../../src/main/extensions/extension-manifest.ts'
import type { ExtensionSessionLike } from '../../src/main/extensions/extension-types.ts'
import type { Workspace } from '../../src/shared/types.ts'
import { createVextPackage } from '../../src/shared/vext-format.ts'
import type { ExtensionCompatibilityRuntime } from '../../src/main/extensions/extension-compatibility-runtime.ts'
import { ICLOUD_PASSWORDS_EXTENSION_ID, type ICloudUpstreamClient } from '../../src/main/extensions/icloud-upstream.ts'
import { discoverChromiumExtensions } from '../../src/main/import/chromium-extension-discovery.ts'

const fixturePath = resolve('tests/fixtures/extensions/content-script-basic')
const managedId = 'abcdefghijklmnopabcdefghijklmnop'

async function writeManagedPackage(root: string, version: string, manifestPatch: Record<string, unknown> = {}): Promise<string> {
  const manifest = JSON.parse(await readFile(join(fixturePath, 'manifest.json'), 'utf8')) as Record<string, unknown>
  Object.assign(manifest, manifestPatch, { version })
  const bytes = await createVextPackage({ extensionId: managedId, version, publisherId: null, files: new Map([
    ['content.js', new Uint8Array(await readFile(join(fixturePath, 'content.js')))],
    ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))]
  ]) })
  const output = join(root, `fixture-${version}.vext`)
  await writeFile(output, bytes)
  return output
}

interface FakeExtensionRuntime extends ExtensionSessionLike {
  loadCalls: string[]
  removeCalls: string[]
  reloadCalls: string[]
  loadedIds: string[]
  storageByExtensionId: Map<string, Map<string, unknown>>
}

function workspace(
  id: string,
  sessionMode: 'isolated' | 'shared' | 'ephemeral' = 'isolated',
  isPrivate = false
): Pick<Workspace, 'id' | 'isPrivate' | 'identity'> {
  return {
    id,
    isPrivate,
    identity: { sessionMode, proxyMode: 'system', proxyServer: '', proxyBypassRules: '<local>' }
  }
}

function fakeRuntime(): FakeExtensionRuntime {
  const loaded = new Map<string, Electron.Extension>()
  const runtime: FakeExtensionRuntime = {
    loadCalls: [],
    removeCalls: [],
    reloadCalls: [],
    loadedIds: [],
    storageByExtensionId: new Map(),
    isPersistent: () => true,
    extensions: {
      async loadExtension(path) {
        runtime.loadCalls.push(path)
        const validated = await validateExtensionManifest(path)
        const id = chromeExtensionId(validated.rootPath, validated.manifest.key)
        runtime.loadedIds.push(id)
        if (!runtime.storageByExtensionId.has(id)) runtime.storageByExtensionId.set(id, new Map())
        const extension = { id, name: validated.manifest.name, version: validated.manifest.version, path } as Electron.Extension
        loaded.set(id, extension)
        return extension
      },
      removeExtension(id) {
        runtime.removeCalls.push(id)
        loaded.delete(id)
      },
      getExtension(id) {
        return loaded.get(id) ?? null
      }
    }
  }
  return runtime
}

function enableNativeReload(runtime: FakeExtensionRuntime): void {
  ;(runtime.extensions as typeof runtime.extensions & { reloadExtension(id: string): void }).reloadExtension = (id) => {
    runtime.reloadCalls.push(id)
  }
}

async function managerHarness(compatibilityRuntime?: ExtensionCompatibilityRuntime): Promise<{
  root: string
  extensionPath: string
  sessions: Map<string, FakeExtensionRuntime>
  manager: ExtensionManager
}> {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-manager-'))
  const extensionPath = join(root, 'fixture')
  await cp(fixturePath, extensionPath, { recursive: true })
  const sessions = new Map<string, FakeExtensionRuntime>()
  const manager = new ExtensionManager({
    userDataRoot: root,
    compatibilityRuntime,
    sessionProvider: (partition) => {
      let runtime = sessions.get(partition)
      if (!runtime) {
        runtime = fakeRuntime()
        sessions.set(partition, runtime)
      }
      return runtime
    }
  })
  return { root, extensionPath, sessions, manager }
}

test('explicit disable and uninstall clear privacy control while reload preserves it', async () => {
  const removed: string[] = []
  const compatibilityRuntime = {
    enabled: true,
    prepareSession: async () => undefined,
    removePrivacyControl: async (extensionId: string) => { removed.push(extensionId) }
  } as unknown as ExtensionCompatibilityRuntime
  const harness = await managerHarness(compatibilityRuntime)
  try {
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)

    await harness.manager.reload(installed.id)
    assert.deepEqual(removed, [])
    await harness.manager.disable(installed.id)
    assert.deepEqual(removed, [installed.id])
    await harness.manager.enable(installed.id)
    await harness.manager.remove(installed.id)
    assert.deepEqual(removed, [installed.id, installed.id])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('local Chromium import never loads before exact permission consent and preserves original ID', async () => {
  const harness = await managerHarness()
  const key = Buffer.alloc(128, 5).toString('base64')
  const sourceId = chromeExtensionId('unused', key)
  const profilePath = join(harness.root, 'Chrome', 'Default')
  const source = join(profilePath, 'Extensions', sourceId, '1.0.0_0')
  try {
    await (await import('node:fs/promises')).mkdir(source, { recursive: true })
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3,
      name: 'Controlled local extension', version: '1.0.0', key,
      permissions: ['storage'], host_permissions: ['https://example.com/*'],
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }] }))
    await writeFile(join(source, 'content.js'), 'globalThis.controlled = true')
    await writeFile(join(profilePath, 'Preferences'), JSON.stringify({ extensions: { settings: {
      [sourceId]: { state: 1, manifest: { version: '1.0.0' } }
    } } }))
    await harness.manager.initialize([workspace('one')])
    const [detected] = await discoverChromiumExtensions(profilePath)
    const input = { profilePath, sourceExtensionId: sourceId, version: '1.0.0', fingerprint: detected.fingerprint, sourceEnabled: true }
    const preview = await harness.manager.prepareLocalChromiumImport(input)
    assert.equal(preview.source, 'local-chromium')
    assert.equal(preview.trust, 'local')
    assert.equal(preview.publisherName, 'Local / Unverified')
    assert.deepEqual(preview.permissions, { chrome: ['storage'], hosts: ['https://example.com/*'], vast: [] })
    assert.equal([...harness.sessions.values()].reduce((total, session) => total + session.loadCalls.length, 0), 0)
    await assert.rejects(harness.manager.confirmLocalChromiumImport(preview.token, { chrome: [], hosts: [], vast: [] }), /permissions/i)
    assert.equal([...harness.sessions.values()].reduce((total, session) => total + session.loadCalls.length, 0), 0)
    const retry = await harness.manager.prepareLocalChromiumImport(input)
    const installed = await harness.manager.confirmLocalChromiumImport(retry.token, retry.permissions)
    assert.equal(installed.id, sourceId)
    assert.equal(installed.source, 'local-chromium')
    assert.equal(installed.trust, 'local')
    assert.equal([...harness.sessions.values()].reduce((total, session) => total + session.loadCalls.length, 0), 1)
    await assert.rejects(harness.manager.prepareLocalChromiumImport(input), /already installed/i)
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('a source-disabled local Chromium extension stays disabled after install and manager restart', async () => {
  const harness = await managerHarness()
  const key = Buffer.alloc(128, 6).toString('base64')
  const sourceId = chromeExtensionId('unused', key)
  const profilePath = join(harness.root, 'Edge', 'Default')
  const source = join(profilePath, 'Extensions', sourceId, '1.0.0_0')
  try {
    await (await import('node:fs/promises')).mkdir(source, { recursive: true })
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3,
      name: 'Disabled source fixture', version: '1.0.0', key,
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }] }))
    await writeFile(join(source, 'content.js'), 'globalThis.controlled = true')
    await writeFile(join(profilePath, 'Preferences'), JSON.stringify({ extensions: { settings: {
      [sourceId]: { state: 0, manifest: { version: '1.0.0' } }
    } } }))
    await harness.manager.initialize([workspace('one')])
    const [detected] = await discoverChromiumExtensions(profilePath)
    const preview = await harness.manager.prepareLocalChromiumImport({ profilePath,
      sourceExtensionId: sourceId, version: '1.0.0', fingerprint: detected.fingerprint, sourceEnabled: false })
    const installed = await harness.manager.confirmLocalChromiumImport(preview.token, preview.permissions)
    assert.equal(installed.enabled, false)
    assert.equal([...harness.sessions.values()].reduce((total, session) => total + session.loadCalls.length, 0), 0)
    const restartSessions = new Map<string, FakeExtensionRuntime>()
    const restarted = new ExtensionManager({ userDataRoot: harness.root, sessionProvider: (partition) => {
      let runtime = restartSessions.get(partition)
      if (!runtime) { runtime = fakeRuntime(); restartSessions.set(partition, runtime) }
      return runtime
    } })
    await restarted.initialize([workspace('one')])
    assert.equal((await restarted.list()).find((item) => item.id === sourceId)?.enabled, false)
    assert.equal([...restartSessions.values()].reduce((total, session) => total + session.loadCalls.length, 0), 0)
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('local Chromium preparation refuses a changed source fingerprint without installing anything', async () => {
  const harness = await managerHarness()
  const key = Buffer.alloc(128, 8).toString('base64')
  const sourceId = chromeExtensionId('unused', key)
  const profilePath = join(harness.root, 'Chrome', 'Default')
  const source = join(profilePath, 'Extensions', sourceId, '1.0.0_0')
  try {
    await (await import('node:fs/promises')).mkdir(source, { recursive: true })
    const manifest = { manifest_version: 3, name: 'Before', version: '1.0.0', key,
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }] }
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(source, 'content.js'), 'globalThis.controlled = true')
    await writeFile(join(profilePath, 'Preferences'), JSON.stringify({ extensions: { settings: {
      [sourceId]: { state: 1, manifest: { version: '1.0.0' } }
    } } }))
    const [detected] = await discoverChromiumExtensions(profilePath)
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, name: 'After' }))
    await harness.manager.initialize([workspace('one')])
    await assert.rejects(harness.manager.prepareLocalChromiumImport({ profilePath, sourceExtensionId: sourceId,
      version: '1.0.0', fingerprint: detected.fingerprint, sourceEnabled: true }), /changed/i)
    assert.deepEqual(await harness.manager.list(), [])
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('a disabled compatibility gate never loads Chrome extensions into Electron sessions', async () => {
  const compatibilityRuntime = {
    enabled: false,
    reason: 'internal rollback switch is on',
    prepareSession: async () => { throw new Error('must not initialize') }
  } as unknown as ExtensionCompatibilityRuntime
  const harness = await managerHarness(compatibilityRuntime)
  try {
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)

    assert.equal(installed.runtimeState, 'error')
    assert.equal([...harness.sessions.values()].reduce((sum, session) => sum + session.loadCalls.length, 0), 0)
    assert.match(installed.error ?? '', /compatibility is disabled/i)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('a compatibility failure in a later session unloads an already loaded Chrome extension', async () => {
  let prepares = 0
  const compatibilityRuntime = {
    enabled: true,
    reason: 'validated test runtime',
    prepareSession: async () => {
      prepares += 1
      if (prepares === 2) {
        compatibilityRuntime.enabled = false
        compatibilityRuntime.reason = 'disabled after compatibility runtime initialization failure'
        throw new Error('second session failed')
      }
    }
  } as unknown as ExtensionCompatibilityRuntime
  const harness = await managerHarness(compatibilityRuntime)
  try {
    await harness.manager.initialize([workspace('one'), workspace('two')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    const sessions = [...harness.sessions.values()]

    assert.equal(installed.runtimeState, 'error')
    assert.equal(sessions.reduce((sum, session) => sum + session.loadCalls.length, 0), 1)
    assert.equal(sessions.reduce((sum, session) => sum + session.removeCalls.length, 0), 1)
    assert.equal(compatibilityRuntime.enabled, false)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('derives only persistent website partitions and never private/default UI sessions', () => {
  const partitions = extensionPartitionsForWorkspaces([
    workspace('personal'),
    workspace('shared', 'shared'),
    workspace('temporary', 'ephemeral'),
    workspace('private', 'isolated', true)
  ])
  assert.deepEqual(partitions, ['persist:vast-default', 'persist:vast-workspace-personal'])
  assert.equal(isEligibleExtensionPartition('persist:vast-default'), true)
  assert.equal(isEligibleExtensionPartition('persist:vast-workspace-personal'), true)
  assert.equal(isEligibleExtensionPartition('vast-workspace-private'), false)
  assert.equal(isEligibleExtensionPartition('default'), false)
})

test('loads, disables, enables, reloads, and removes across all persistent workspace sessions', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one'), workspace('two')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    assert.equal(installed.runtimeState, 'loaded')
    assert.equal(installed.loadedSessionCount, 2)
    assert.equal(harness.sessions.size, 2)
    assert.deepEqual([...harness.sessions.values()].map((session) => session.loadCalls.length), [1, 1])
    const duplicate = await harness.manager.installUnpacked(harness.extensionPath)
    assert.equal(duplicate.id, installed.id)
    assert.deepEqual([...harness.sessions.values()].map((session) => session.loadCalls.length), [1, 1])

    const disabled = await harness.manager.disable(installed.id)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.runtimeState, 'disabled')
    assert.deepEqual([...harness.sessions.values()].map((session) => session.removeCalls.length), [1, 1])
    const reloadedWhileDisabled = await harness.manager.reload(installed.id)
    assert.equal(reloadedWhileDisabled.runtimeState, 'disabled')
    assert.deepEqual([...harness.sessions.values()].map((session) => session.loadCalls.length), [1, 1])

    const enabled = await harness.manager.enable(installed.id)
    assert.equal(enabled.loadedSessionCount, 2)
    assert.deepEqual([...harness.sessions.values()].map((session) => session.loadCalls.length), [2, 2])

    await harness.manager.reload(installed.id)
    assert.deepEqual([...harness.sessions.values()].map((session) => session.loadCalls.length), [3, 3])
    assert.deepEqual([...harness.sessions.values()].map((session) => session.removeCalls.length), [2, 2])

    assert.equal(await harness.manager.remove(installed.id), true)
    assert.deepEqual(await harness.manager.list(), [])
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('loads enabled extensions into a newly created persistent workspace without restart', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    await harness.manager.syncWorkspaces([workspace('one'), workspace('later')])

    const info = (await harness.manager.list()).find((extension) => extension.id === installed.id)
    assert.equal(info?.loadedSessionCount, 2)
    assert.equal(harness.sessions.get('persist:vast-workspace-later')?.loadCalls.length, 1)

    await harness.manager.syncWorkspaces([workspace('one'), workspace('later'), workspace('private', 'isolated', true)])
    assert.equal(harness.sessions.has('vast-workspace-private'), false)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('prepares a one-time Chrome popup surface only for an enabled persistent workspace', async () => {
  const harness = await managerHarness()
  try {
    const manifestPath = join(harness.extensionPath, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.action = { default_popup: 'popup.html' }
    await writeFile(join(harness.extensionPath, 'popup.html'), '<!doctype html><title>Toolbar popup</title>', 'utf8')
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    assert.deepEqual(installed.ui, { popup: true, options: false })

    const partition = 'persist:vast-workspace-one'
    const surface = await harness.manager.prepareSurface(installed.id, 'popup', partition)
    assert.deepEqual(surface, {
      src: `chrome-extension://${installed.id}/popup.html`,
      partition,
      kind: 'popup',
      runtime: 'chrome'
    })
    const attachment = harness.manager.authorizeSurfaceAttachment(surface!.src, surface!.partition)
    assert.equal(typeof attachment?.token, 'string')
    assert.equal(attachment?.preload, undefined)
    assert.equal(harness.manager.authorizeSurfaceAttachment(surface!.src, surface!.partition), undefined)

    await harness.manager.disable(installed.id)
    await assert.rejects(harness.manager.prepareSurface(installed.id, 'popup', partition), /Enable the extension/)
    await assert.rejects(harness.manager.prepareSurface(installed.id, 'popup', 'vast-workspace-private'), /Enable the extension/)
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('restores enabled installations after manager restart and serializes concurrent mutations', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    await Promise.all([
      harness.manager.disable(installed.id),
      harness.manager.enable(installed.id),
      harness.manager.disable(installed.id)
    ])
    assert.equal((await harness.manager.list())[0]?.enabled, false)

    await harness.manager.enable(installed.id)
    const restartedSessions = new Map<string, FakeExtensionRuntime>()
    const restarted = new ExtensionManager({
      userDataRoot: harness.root,
      sessionProvider: (partition) => {
        const runtime = fakeRuntime()
        restartedSessions.set(partition, runtime)
        return runtime
      }
    })
    await restarted.initialize([workspace('one')])
    const restored = (await restarted.list())[0]
    assert.equal(restored?.enabled, true)
    assert.equal(restored?.runtimeState, 'loaded')
    assert.equal(restartedSessions.get('persist:vast-workspace-one')?.loadCalls.length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('reload uses Electron native reload without uninstalling or loading the extension again', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    const runtime = [...harness.sessions.values()][0]
    enableNativeReload(runtime)

    const reloaded = await harness.manager.reload(installed.id)

    assert.equal(reloaded.runtimeState, 'loaded')
    assert.deepEqual(runtime.reloadCalls, [installed.id])
    assert.equal(runtime.removeCalls.length, 0)
    assert.equal(runtime.loadCalls.length, 1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('persists optional Chrome grants per extension and rejects undeclared grants', async () => {
  const harness = await managerHarness()
  try {
    const firstManifestPath = join(harness.extensionPath, 'manifest.json')
    const firstManifest = JSON.parse(await readFile(firstManifestPath, 'utf8')) as Electron.Extension['manifest']
    firstManifest.optional_permissions = ['notifications']
    firstManifest.optional_host_permissions = ['https://accounts.example.test/*']
    await writeFile(firstManifestPath, JSON.stringify(firstManifest), 'utf8')

    const secondPath = join(harness.root, 'fixture-two')
    await cp(fixturePath, secondPath, { recursive: true })
    const secondManifestPath = join(secondPath, 'manifest.json')
    const secondManifest = JSON.parse(await readFile(secondManifestPath, 'utf8')) as Electron.Extension['manifest']
    secondManifest.name = 'Independent extension'
    secondManifest.optional_permissions = ['notifications']
    await writeFile(secondManifestPath, JSON.stringify(secondManifest), 'utf8')

    await harness.manager.initialize([workspace('one')])
    const first = await harness.manager.installUnpacked(harness.extensionPath)
    const second = await harness.manager.installUnpacked(secondPath)
    const firstRuntime = { id: first.id, path: harness.extensionPath, manifest: firstManifest }
    const secondRuntime = { id: second.id, path: secondPath, manifest: secondManifest }

    assert.equal(await harness.manager.addChromePermissionGrants(firstRuntime, {
      permissions: ['notifications'],
      origins: ['https://accounts.example.test/*']
    }), true)
    assert.equal(await harness.manager.addChromePermissionGrants(firstRuntime, { permissions: ['tabs'] }), false)
    assert.deepEqual(harness.manager.getChromePermissionGrants(firstRuntime), {
      permissions: ['notifications'],
      origins: ['https://accounts.example.test/*']
    })
    assert.deepEqual(harness.manager.getChromePermissionGrants(secondRuntime), { permissions: [], origins: [] })

    const restarted = new ExtensionManager({
      userDataRoot: harness.root,
      sessionProvider: () => fakeRuntime()
    })
    await restarted.initialize([workspace('one')])
    assert.deepEqual(restarted.getChromePermissionGrants(firstRuntime), {
      permissions: ['notifications'],
      origins: ['https://accounts.example.test/*']
    })
    assert.deepEqual(restarted.getChromePermissionGrants(secondRuntime), { permissions: [], origins: [] })
    assert.equal(await restarted.removeChromePermissionGrants(firstRuntime, { permissions: ['notifications'] }), true)
    assert.deepEqual(restarted.getChromePermissionGrants(firstRuntime), {
      permissions: [],
      origins: ['https://accounts.example.test/*']
    })
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('keeps a missing unpacked directory installed but reports an actionable runtime error', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    await rm(harness.extensionPath, { recursive: true, force: true })

    const listed = (await harness.manager.list())[0]
    assert.equal(listed?.id, installed.id)
    assert.equal(listed?.runtimeState, 'error')
    assert.match(listed?.error ?? '', /unavailable/)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('isolates a load failure to one workspace and reports the partial runtime state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-partial-load-'))
  const extensionPath = join(root, 'fixture')
  await cp(fixturePath, extensionPath, { recursive: true })
  const healthy = fakeRuntime()
  const failing = fakeRuntime()
  failing.extensions.loadExtension = async () => {
    failing.loadCalls.push(extensionPath)
    throw new Error('Simulated partition load failure')
  }
  const manager = new ExtensionManager({
    userDataRoot: root,
    sessionProvider: (partition) => partition.endsWith('-two') ? failing : healthy
  })
  try {
    await manager.initialize([workspace('one'), workspace('two')])
    const installed = await manager.installUnpacked(extensionPath)
    assert.equal(installed.runtimeState, 'loaded')
    assert.equal(installed.loadedSessionCount, 1)
    assert.equal(installed.eligibleSessionCount, 2)
    assert.match(installed.error ?? '', /Simulated partition load failure/)

    const disabled = await manager.disable(installed.id)
    assert.equal(disabled.runtimeState, 'disabled')
    assert.equal(disabled.error, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installs a local .vext into the managed store with a stable logical identity', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const packagePath = await writeManagedPackage(harness.root, '1.0.0')
    const preview = await harness.manager.prepareLocalPackage(packagePath)
    assert.equal(preview.extensionId, managedId)
    assert.equal(preview.source, 'local-vext')
    assert.equal(preview.trust, 'local')
    const installed = await harness.manager.installPrepared(preview.token)
    assert.equal(installed.id, managedId)
    assert.equal(installed.source, 'local-vext')
    assert.equal(installed.runtimeState, 'loaded')
    assert.match(installed.path, /Extensions[\\/]Managed[\\/]abcdefghijklmnopabcdefghijklmnop[\\/]current$/)

    const restarted = new ExtensionManager({ userDataRoot: harness.root, sessionProvider: () => fakeRuntime() })
    await restarted.initialize([workspace('one')])
    assert.deepEqual((await restarted.list()).map((extension) => [extension.id, extension.version, extension.source]), [[managedId, '1.0.0', 'local-vext']])
    await restarted.remove(managedId)
    await assert.rejects(stat(join(harness.root, 'Extensions', 'Managed', managedId)), /ENOENT/)
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('rolls back the registry, runtime, and candidate directory when a managed update cannot start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-rollback-'))
  const runtime = fakeRuntime()
  const load = runtime.extensions.loadExtension
  runtime.extensions.loadExtension = async (path, options) => {
    if ((await validateExtensionManifest(path)).manifest.version === '2.0.0') throw new Error('Simulated candidate startup failure')
    return load(path, options)
  }
  const manager = new ExtensionManager({ userDataRoot: root, sessionProvider: () => runtime })
  try {
    await manager.initialize([workspace('one')])
    const first = await manager.prepareLocalPackage(await writeManagedPackage(root, '1.0.0'))
    await manager.installPrepared(first.token)
    const originalRuntimeId = runtime.loadedIds.at(-1)
    assert.ok(originalRuntimeId)
    runtime.storageByExtensionId.get(originalRuntimeId)?.set('persisted-secret', 'survives-rollback')
    const update = await manager.prepareLocalPackage(await writeManagedPackage(root, '2.0.0'))
    await assert.rejects(manager.installPrepared(update.token), /previous version was restored.*Simulated candidate startup failure/)
    const restored = (await manager.list())[0]
    assert.equal(restored?.id, managedId)
    assert.equal(restored?.version, '1.0.0')
    assert.equal(restored?.runtimeState, 'loaded')
    assert.equal(runtime.loadedIds.at(-1), originalRuntimeId)
    assert.equal(runtime.storageByExtensionId.get(originalRuntimeId)?.get('persisted-secret'), 'survives-rollback')
    assert.match(restored?.path ?? '', /Extensions[\\/]Managed[\\/]abcdefghijklmnopabcdefghijklmnop[\\/]current$/)
    await assert.rejects(stat(join(root, 'Extensions', 'Managed', managedId, 'releases', '2.0.0')), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('managed updates keep the Electron extension ID, origin, and chrome.storage identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-stable-runtime-'))
  const runtime = fakeRuntime()
  const manager = new ExtensionManager({ userDataRoot: root, sessionProvider: () => runtime })
  try {
    await manager.initialize([workspace('one')])
    const v1 = await manager.prepareLocalPackage(await writeManagedPackage(root, '1.0.0'))
    await manager.installPrepared(v1.token)
    const runtimeIdV1 = runtime.loadedIds.at(-1)
    assert.ok(runtimeIdV1)
    runtime.storageByExtensionId.get(runtimeIdV1)?.set('account', { email: 'saved@example.test' })

    const v2 = await manager.prepareLocalPackage(await writeManagedPackage(root, '2.0.0'))
    const updated = await manager.installPrepared(v2.token)
    const runtimeIdV2 = runtime.loadedIds.at(-1)
    assert.equal(runtimeIdV2, runtimeIdV1)
    assert.equal(`chrome-extension://${runtimeIdV2}`, `chrome-extension://${runtimeIdV1}`)
    assert.deepEqual(runtime.storageByExtensionId.get(runtimeIdV2)?.get('account'), { email: 'saved@example.test' })
    assert.equal(updated.version, '2.0.0')
    assert.match(updated.path, /Extensions[\\/]Managed[\\/]abcdefghijklmnopabcdefghijklmnop[\\/]current$/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('managed releases reject downgrade and same-version replay before activation', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const initial = await harness.manager.prepareLocalPackage(await writeManagedPackage(harness.root, '2.0.0'))
    await harness.manager.installPrepared(initial.token)
    await assert.rejects(
      harness.manager.prepareLocalPackage(await writeManagedPackage(harness.root, '2.0.0')),
      /same-version replay/
    )
    await assert.rejects(
      harness.manager.prepareLocalPackage(await writeManagedPackage(harness.root, '1.9.9')),
      /downgrade/
    )
    assert.equal((await harness.manager.list())[0]?.version, '2.0.0')
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('Hub package verification compares signed required permissions without treating optional grants as tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-hub-required-permissions-'))
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Hub permission fixture',
      version: '1.0.0',
      permissions: ['storage'],
      optional_permissions: ['privacy', 'nativeMessaging']
    }), 'utf8')
    const validated = await validateExtensionManifest(root)
    const manager = new ExtensionManager({ userDataRoot: root, sessionProvider: () => fakeRuntime() })
    const internals = manager as unknown as {
      assertPreparedPackage: (pending: unknown, staged: unknown, validatedManifest: typeof validated) => void
    }
    const packageSha256 = 'a'.repeat(64)
    const descriptor = {
      descriptor: {
        schema: 1,
        extension_id: managedId,
        publisher_id: 'publisher_test',
        version: '1.0.0',
        package_url: `https://extensions.vastbrowser.com/packages/${managedId}/1.0.0/${packageSha256}.vext`,
        sha256: packageSha256,
        key_id: 'vast-hub-2026-02',
        permissions: { chrome: ['storage'], hosts: [], vast: [] },
        published_at: '2026-09-25T00:00:00.000Z'
      },
      signature: { signature_version: 1, algorithm: 'Ed25519', key_id: 'vast-hub-2026-02', signature: 'test' }
    }
    const staged = {
      source: 'hub',
      parsed: {
        verifiedKeyId: 'vast-hub-2026-02',
        packageSha256,
        metadata: { extension_id: managedId, publisher_id: 'publisher_test', version: '1.0.0' }
      }
    }

    const permissions = { chrome: ['storage'], hosts: [], vast: [] }
    const pending = {
      token: 'prepared-token',
      expiresAt: Date.now() + 60_000,
      preview: {
        token: 'prepared-token',
        extensionId: managedId,
        name: 'Hub permission fixture',
        version: '1.0.0',
        publisherName: 'Test Publisher',
        source: 'hub',
        trust: 'reviewed',
        kind: 'chrome',
        permissions,
        isUpdate: false,
        permissionEscalation: permissions
      },
      descriptor
    }

    assert.doesNotThrow(() => internals.assertPreparedPackage(pending, staged, validated))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Hub permission escalation waits for explicit approval before downloading an update', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one')])
    const initial = await harness.manager.prepareLocalPackage(await writeManagedPackage(harness.root, '1.0.0', { optional_permissions: ['tabs'] }))
    await harness.manager.installPrepared(initial.token)
    const internals = harness.manager as unknown as {
      registry: { patch: (id: string, patch: Record<string, unknown>) => Promise<unknown> }
      hubClient: { descriptor: (id: string) => Promise<unknown>; download: () => Promise<Uint8Array> }
    }
    await internals.registry.patch(managedId, { source: 'hub', publisherId: 'vast-test-publisher', publisherName: 'Vast Test Publisher' })
    let downloads = 0
    internals.hubClient = {
      descriptor: async () => ({
        descriptor: {
          schema: 1, extension_id: managedId, publisher_id: 'vast-test-publisher', version: '2.0.0',
          package_url: `https://extensions.vastbrowser.com/packages/${managedId}/2.0.0/${'a'.repeat(64)}.vext`,
          sha256: 'a'.repeat(64), key_id: 'vast-hub-2026-02', published_at: '2026-09-15T00:00:00.000Z',
          permissions: { chrome: ['storage', 'tabs'], hosts: ['http://127.0.0.1/*', 'http://localhost/*'], vast: [] }
        },
        signature: { signature_version: 1, algorithm: 'Ed25519', key_id: 'vast-hub-2026-02', signature: 'test' }
      }),
      download: async () => { downloads += 1; throw new Error('approval reached download') }
    }

    const [pending] = await harness.manager.checkForUpdates(managedId)
    assert.equal(pending?.version, '1.0.0')
    assert.equal(pending?.update.state, 'pending-approval')
    assert.equal(pending?.update.availableVersion, '2.0.0')
    assert.equal(downloads, 0)
    await assert.rejects(harness.manager.approveUpdate(managedId), /approval reached download/)
    assert.equal(downloads, 1)
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('iCloud upstream install preserves identity across restart and updates from the same narrow channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-icloud-upstream-'))
  const manifestKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAk4xPYZla5XqlDN0PPiLCQAYRqdaR06jSl3sntEE5jHoe7XldFqhsdBSp4L8mozwjCwi6z5YtEpTV1L2k4WYmDuiwoH7YKGlQD/YbC8QMcPvGLWOr8WYfXWtECKv0Nx7Tahk8nCIDWgJVm8YmPIDhPv4o5VVrq6aUveCKvTOskHWFyRzSTC2VKpzIVX7F65UzqqOmqLfMpo6lfaLcKSC7G6oQLA/wS7hcGZEwZ11si6XWR4o/hDuUSt6zdacy/sc7H80eH3lMnEmvb6HoB7+KvxfGIU7dqRmhA/w/X0qkiIJYeoo4tZrNxBj7TTLz9hnHUbMRwJqsoIU+pkoprgFWDQIDAQAB'
  const upstreamPackage = (version: string, hash: string) => ({
    extensionId: ICLOUD_PASSWORDS_EXTENSION_ID,
    version,
    packageSha256: hash.repeat(64),
    files: new Map([['manifest.json', new TextEncoder().encode(JSON.stringify({ manifest_version: 3, name: 'Synthetic iCloud identity fixture', version, key: manifestKey, permissions: ['storage'] }))]])
  })
  const details = {
    id: ICLOUD_PASSWORDS_EXTENSION_ID,
    slug: 'icloud-passwords',
    name: 'iCloud Passwords',
    summary: 'Install directly from the original upstream channel.',
    description: 'Synthetic Hub metadata used by the manager test.',
    publisher: { id: 'publisher_upstreamappleinc', name: 'Apple', verified: false },
    category: 'password-managers',
    kind: 'chrome',
    version: '3.3.0',
    updatedAt: '2026-09-25T00:00:00.000Z',
    downloads: 0,
    distribution: 'upstream',
    sourceRef: `Chrome Web Store ${ICLOUD_PASSWORDS_EXTENSION_ID}`,
    dataPractice: 'external-processing',
    screenshots: [],
    permissions: { chrome: ['storage'], hosts: [], vast: [] },
    installed: false
  }
  const setHubDetails = (manager: ExtensionManager) => {
    const internals = manager as unknown as { hubClient: { details: () => Promise<typeof details> } }
    internals.hubClient = { details: async () => details }
  }
  try {
    const firstRuntime = fakeRuntime()
    const firstUpstream = { latest: async () => upstreamPackage('3.3.0', 'a') } as unknown as ICloudUpstreamClient
    const firstManager = new ExtensionManager({ userDataRoot: root, sessionProvider: () => firstRuntime, upstreamClient: firstUpstream })
    await firstManager.initialize([workspace('one')])
    setHubDetails(firstManager)
    const preview = await firstManager.prepareHubInstall(ICLOUD_PASSWORDS_EXTENSION_ID)
    assert.equal(preview.source, 'upstream')
    assert.equal(preview.trust, 'upstream')
    const installed = await firstManager.installPrepared(preview.token)
    assert.equal(installed.id, ICLOUD_PASSWORDS_EXTENSION_ID)
    assert.equal(installed.version, '3.3.0')
    assert.equal(installed.source, 'upstream')
    assert.equal(firstRuntime.loadedIds.at(-1), ICLOUD_PASSWORDS_EXTENSION_ID)

    const restartedRuntime = fakeRuntime()
    const updateUpstream = {
      latest: async (currentVersion?: string) => currentVersion === '3.3.0' ? upstreamPackage('3.4.0', 'b') : upstreamPackage('3.3.0', 'a')
    } as unknown as ICloudUpstreamClient
    const restarted = new ExtensionManager({ userDataRoot: root, sessionProvider: () => restartedRuntime, upstreamClient: updateUpstream })
    await restarted.initialize([workspace('one')])
    const [restored] = await restarted.list()
    assert.equal(restored?.id, ICLOUD_PASSWORDS_EXTENSION_ID)
    assert.equal(restored?.source, 'upstream')
    assert.equal(restored?.trust, 'upstream')
    assert.equal(restartedRuntime.loadedIds.at(-1), ICLOUD_PASSWORDS_EXTENSION_ID)

    const [updated] = await restarted.checkForUpdates(ICLOUD_PASSWORDS_EXTENSION_ID)
    assert.equal(updated?.version, '3.4.0')
    assert.equal(updated?.source, 'upstream')
    assert.equal(updated?.update.state, 'up-to-date')
    assert.equal(restartedRuntime.loadedIds.at(-1), ICLOUD_PASSWORDS_EXTENSION_ID)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('uninstall clears only its own Chrome-origin storage while disable preserves it', async () => {
  const harness = await managerHarness()
  try {
    await harness.manager.initialize([workspace('one'), workspace('two')])
    const installed = await harness.manager.installUnpacked(harness.extensionPath)
    const cleared: unknown[] = []
    for (const runtime of harness.sessions.values()) runtime.clearStorageData = async options => { cleared.push(options) }
    await harness.manager.disable(installed.id)
    assert.deepEqual(cleared, [])
    await harness.manager.remove(installed.id)
    assert.equal(cleared.length, 2)
    for (const options of cleared) assert.deepEqual(options, { origin: `chrome-extension://${installed.id}` })
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})
