import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtensionManager } from '../../src/main/extensions/extension-manager.ts'
import type { ExtensionSessionLike } from '../../src/main/extensions/extension-types.ts'
import type { VastExtensionContributionSnapshot } from '../../src/shared/extension-native-api.ts'

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>'

function sessionProvider(): (partition: string) => ExtensionSessionLike {
  return () => ({ isPersistent: () => true, extensions: { loadExtension: async () => { throw new Error('A Vast-only extension has no Chrome layer.') }, removeExtension: () => undefined, getExtension: () => null } })
}

async function writeStatic(dir: string, manifestPatch: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'popup.html'), '<!doctype html><title>Popup</title>', 'utf8')
  await writeFile(join(dir, 'icon.svg'), ICON, 'utf8')
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Static UI', version: '1.0.0',
    vast: { api_version: 1, popup: 'popup.html', permissions: ['vast.toolbar', 'vast.commands'], contributes: {
      toolbar: [{ id: 'open', title: 'Open', icon: 'icon.svg', action: 'popup' }],
      commands: [{ id: 'open', title: 'Open from palette', action: 'popup' }]
    } },
    ...manifestPatch
  }), 'utf8')
}

async function harness(): Promise<{ root: string; extensionPath: string; manager: ExtensionManager; snapshots: VastExtensionContributionSnapshot[]; create: () => ExtensionManager }> {
  const root = await mkdtemp(join(tmpdir(), 'vast-declarative-'))
  const extensionPath = join(root, 'extension')
  await writeStatic(extensionPath)
  const snapshots: VastExtensionContributionSnapshot[] = []
  const create = (): ExtensionManager => new ExtensionManager({ userDataRoot: root, sessionProvider: sessionProvider(), onContributionsChanged: (snapshot) => snapshots.push(snapshot) })
  const manager = create()
  await manager.initialize([{ id: 'one', isPrivate: false, identity: { sessionMode: 'isolated', proxyMode: 'system', proxyServer: '', proxyBypassRules: '<local>' } }])
  return { root, extensionPath, manager, snapshots, create }
}

const nativeRuntimeOf = (manager: ExtensionManager): unknown => (manager as unknown as { nativeRuntime?: unknown }).nativeRuntime

test('a declarative-only extension shows its UI after approval without any Native host', async () => {
  const { root, extensionPath, manager } = await harness()
  try {
    let info = await manager.installUnpacked(extensionPath)
    // Declared is not granted: nothing is visible until the user approves.
    assert.equal(info.native.state, 'pending-permission')
    assert.equal(manager.contributionSnapshot().toolbar.length, 0)
    info = await manager.approvePermissions(info.id, ['vast.toolbar', 'vast.commands'])
    assert.equal(info.native.state, 'idle')
    const snapshot = manager.contributionSnapshot()
    assert.deepEqual(snapshot.toolbar.map((item) => [item.key, item.source, item.action, item.available]), [[`${info.id}:toolbar:open`, 'manifest', 'popup', true]])
    assert.match(snapshot.toolbar[0].iconDataUrl ?? '', /^data:image\/svg\+xml;base64,/)
    assert.equal(snapshot.commands.length, 1)
    assert.equal(snapshot.nativeTabEvents, false)
    // No code ran: the Native runtime (and every hidden host window) was never created.
    assert.equal(nativeRuntimeOf(manager), undefined)
    assert.deepEqual(await manager.dispatchContribution(`${info.id}:toolbar:open`), { outcome: 'popup', extensionId: info.id })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dispatch re-checks ownership, enablement and grants at activation time', async () => {
  const { root, extensionPath, manager } = await harness()
  try {
    const { id } = await manager.installUnpacked(extensionPath)
    await manager.approvePermissions(id, ['vast.toolbar', 'vast.commands'])
    await assert.rejects(manager.dispatchContribution('pppppppppppppppppppppppppppppppp:toolbar:open'), /unavailable/)
    await assert.rejects(manager.dispatchContribution(`${id}:toolbar:missing`), /unavailable/)
    await manager.setPermission(id, 'vast.toolbar', false)
    assert.equal(manager.contributionSnapshot().toolbar.length, 0)
    await assert.rejects(manager.dispatchContribution(`${id}:toolbar:open`), /unavailable/)
    // The palette command survives: only the revoked section disappeared.
    assert.equal(manager.contributionSnapshot().commands.length, 1)
    assert.deepEqual(await manager.dispatchContribution(`${id}:commands:open`), { outcome: 'popup', extensionId: id })
    await manager.setPermission(id, 'vast.toolbar', true)
    assert.equal(manager.contributionSnapshot().toolbar.length, 1)
    await manager.disable(id)
    assert.equal(manager.contributionSnapshot().toolbar.length + manager.contributionSnapshot().commands.length, 0)
    await assert.rejects(manager.dispatchContribution(`${id}:toolbar:open`), /unavailable/)
    await manager.enable(id)
    assert.equal(manager.contributionSnapshot().toolbar.length, 1)
    await manager.remove(id)
    assert.equal(manager.contributionSnapshot().toolbar.length + manager.contributionSnapshot().commands.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('authorized contributions are restored after a restart from persisted grants only', async () => {
  const { root, extensionPath, manager, create } = await harness()
  try {
    const { id } = await manager.installUnpacked(extensionPath)
    await manager.approvePermissions(id, ['vast.toolbar'])
    assert.equal((await manager.list())[0].native.state, 'pending-permission')
    await manager.approvePermissions(id, ['vast.toolbar', 'vast.commands'])
    await manager.shutdown()
    const restarted = create()
    await restarted.initialize([{ id: 'one', isPrivate: false, identity: { sessionMode: 'isolated', proxyMode: 'system', proxyServer: '', proxyBypassRules: '<local>' } }])
    const snapshot = restarted.contributionSnapshot()
    assert.equal(snapshot.toolbar.length, 1)
    assert.equal(snapshot.toolbar[0].extensionId, id)
    assert.equal(nativeRuntimeOf(restarted), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an update cannot silently widen permissions or action scope', async () => {
  const { root, extensionPath, manager } = await harness()
  try {
    const { id } = await manager.installUnpacked(extensionPath)
    await manager.approvePermissions(id, ['vast.toolbar', 'vast.commands'])
    // The new version adds a context menu that needs a new permission.
    await writeStatic(extensionPath, { version: '1.1.0', vast: { api_version: 1, popup: 'popup.html', permissions: ['vast.toolbar', 'vast.commands', 'vast.contextMenus', 'vast.tabs.read'], contributes: {
      toolbar: [{ id: 'open', title: 'Open', action: 'popup' }],
      context_menus: [{ id: 'sel', title: 'Selection', contexts: ['selection'], action: 'popup' }]
    } } })
    let info = await manager.reload(id)
    // context_menus with action popup is invalid: the Native layer is disabled, not partially applied.
    assert.equal(info.native.state, 'error')
    assert.equal(manager.contributionSnapshot().toolbar.length, 0)
    await writeStatic(extensionPath, { version: '1.2.0', vast: { api_version: 1, popup: 'popup.html', permissions: ['vast.toolbar', 'vast.commands', 'vast.tabs.read'], contributes: { toolbar: [{ id: 'open', title: 'Open', action: 'popup' }] } } })
    info = await manager.reload(id)
    assert.equal(info.native.state, 'pending-permission')
    assert.deepEqual(info.native.grantedPermissions.sort(), ['vast.commands', 'vast.toolbar'])
    assert.equal(manager.contributionSnapshot().toolbar.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('repeated enable, approve and toggle cycles leave exactly one set of contributions', async () => {
  const { root, extensionPath, manager, snapshots } = await harness()
  try {
    const { id } = await manager.installUnpacked(extensionPath)
    await manager.approvePermissions(id, ['vast.toolbar', 'vast.commands'])
    await Promise.all([manager.enable(id), manager.enable(id), manager.approvePermissions(id, ['vast.toolbar', 'vast.commands'])])
    for (let index = 0; index < 10; index += 1) { await manager.disable(id); await manager.enable(id) }
    const snapshot = manager.contributionSnapshot()
    assert.equal(snapshot.toolbar.length, 1)
    assert.equal(snapshot.commands.length, 1)
    assert.ok(snapshots.length > 0)
    assert.equal(nativeRuntimeOf(manager), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
