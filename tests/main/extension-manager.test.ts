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

const fixturePath = resolve('tests/fixtures/extensions/content-script-basic')
const managedId = 'abcdefghijklmnopabcdefghijklmnop'

async function writeManagedPackage(root: string, version: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(fixturePath, 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.version = version
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
    isPersistent: () => true,
    extensions: {
      async loadExtension(path) {
        runtime.loadCalls.push(path)
        const validated = await validateExtensionManifest(path)
        const id = chromeExtensionId(validated.rootPath, validated.manifest.key)
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

async function managerHarness(): Promise<{
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
    assert.match(installed.path, /Extensions[\\/]Managed[\\/]abcdefghijklmnopabcdefghijklmnop[\\/]versions[\\/]1\.0\.0$/)

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
    const update = await manager.prepareLocalPackage(await writeManagedPackage(root, '2.0.0'))
    await assert.rejects(manager.installPrepared(update.token), /previous version was restored.*Simulated candidate startup failure/)
    const restored = (await manager.list())[0]
    assert.equal(restored?.id, managedId)
    assert.equal(restored?.version, '1.0.0')
    assert.equal(restored?.runtimeState, 'loaded')
    await assert.rejects(stat(join(root, 'Extensions', 'Managed', managedId, 'versions', '2.0.0')), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
