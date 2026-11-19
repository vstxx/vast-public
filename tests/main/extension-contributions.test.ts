import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionContributionRegistry, validateTheme } from '../../src/main/extensions/extension-contributions.ts'

test('contributions are namespaced, bounded, and removed by permission or owner', () => {
  const registry = new ExtensionContributionRegistry((id) => id === 'a' ? 'A' : 'B', () => undefined)
  registry.createToolbar('a', { id: 'save', title: 'Save A' })
  registry.createToolbar('b', { id: 'save', title: 'Save B' })
  assert.deepEqual(registry.snapshot().toolbar.map((item) => item.key), ['a:toolbar:save', 'b:toolbar:save'])
  registry.removePermission('a', 'vast.toolbar')
  assert.deepEqual(registry.snapshot().toolbar.map((item) => item.key), ['b:toolbar:save'])
  registry.removeExtension('b')
  assert.equal(registry.snapshot().toolbar.length, 0)
})

test('theme contributions are validated, clamped, layered deterministically, and restored', () => {
  assert.deepEqual(validateTheme({ accentColor: '#8b5cf6', cornerRadius: 999, saturation: 1 }), { accentColor: '#8b5cf6', cornerRadius: 36, saturation: 80 })
  assert.throws(() => validateTheme({ css: 'body { display:none }' }), /unsupported token/)
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  registry.applyTheme('a', { accentColor: '#111111' })
  registry.applyTheme('b', { accentColor: '#222222' })
  assert.equal(registry.snapshot().theme?.extensionId, 'b')
  registry.clearTheme('b')
  assert.equal(registry.snapshot().theme?.extensionId, 'a')
})

const declared = {
  toolbar: [{ id: 'open', title: 'Open', icon: 'a.svg', action: 'popup' as const }, { id: 'ping', title: 'Ping', action: 'event' as const }],
  commands: [{ id: 'cmd', title: 'Command', action: 'event' as const }],
  context_menus: [{ id: 'sel', title: 'Selection', contexts: ['selection' as const], action: 'event' as const }],
  sidebar: [{ id: 'panel', title: 'Panel', page: 'panel.html' }]
}
const grants = ['vast.toolbar', 'vast.commands', 'vast.contextMenus', 'vast.sidebar'] as const

test('manifest contributions register without a host, only for granted sections', () => {
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  registry.setDeclared('a', declared, ['vast.toolbar'], new Map([['a.svg', 'data:image/svg+xml;base64,AA==']]))
  const snapshot = registry.snapshot()
  assert.deepEqual(snapshot.toolbar.map((item) => [item.key, item.source, item.action, item.available]), [['a:toolbar:open', 'manifest', 'popup', true], ['a:toolbar:ping', 'manifest', 'event', false]])
  assert.equal(snapshot.toolbar[0].iconDataUrl, 'data:image/svg+xml;base64,AA==')
  assert.equal(snapshot.commands.length + snapshot.contextMenus.length + snapshot.sidebar.length, 0)
  // Re-declaring replaces instead of accumulating.
  registry.setDeclared('a', declared, [...grants])
  assert.equal(registry.snapshot().toolbar.length, 2)
  assert.equal(registry.snapshot().sidebar[0].resourceUrl, 'vast-extension://a/panel.html')
  assert.deepEqual(registry.ownerFor('a:contextMenus:sel'), { extensionId: 'a', type: 'contextMenus', localId: 'sel', source: 'manifest', action: 'event', contexts: ['selection'] })
})

test('event actions are available only while the owner background runs', () => {
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  registry.setDeclared('a', declared, [...grants])
  registry.setHostRunning('a', true)
  assert.equal(registry.snapshot().toolbar.find((item) => item.id === 'ping')?.available, true)
  registry.createToolbar('a', { id: 'dynamic', title: 'Dynamic' })
  // A stopped or crashed background takes its runtime entries; manifest entries stay but become unavailable.
  registry.removeRuntime('a')
  const toolbar = registry.snapshot().toolbar
  assert.deepEqual(toolbar.map((item) => item.id), ['open', 'ping'])
  assert.equal(toolbar.find((item) => item.id === 'ping')?.available, false)
  assert.equal(toolbar.find((item) => item.id === 'open')?.available, true)
})

test('a background cannot shadow, edit, or remove what its manifest declares', () => {
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  registry.setDeclared('a', declared, [...grants])
  assert.throws(() => registry.createToolbar('a', { id: 'open', title: 'Hijack' }), /declared in the extension manifest/)
  assert.throws(() => registry.updateToolbar('a', 'open', { title: 'Hijack' }), /does not exist/)
  assert.throws(() => registry.removeToolbar('a', 'open'), /cannot be removed at runtime/)
  assert.throws(() => registry.createContextMenu('a', { id: 'sel', title: 'Hijack' }), /declared in the extension manifest/)
  // Manifest and runtime entries share one per-extension limit.
  for (let index = 0; index < 3; index += 1) registry.createToolbar('a', { id: `r${index}`, title: 'R' })
  assert.throws(() => registry.createToolbar('a', { id: 'r9', title: 'R' }), /limit reached \(5\)/)
})

test('two extensions may use the same local IDs without crossing ownership', () => {
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  registry.setDeclared('a', declared, [...grants])
  registry.setDeclared('b', declared, [...grants])
  assert.equal(registry.ownerFor('a:toolbar:ping')?.extensionId, 'a')
  assert.equal(registry.ownerFor('b:toolbar:ping')?.extensionId, 'b')
  registry.setHostRunning('b', true)
  assert.deepEqual(registry.snapshot().toolbar.filter((item) => item.id === 'ping').map((item) => [item.extensionId, item.available]), [['a', false], ['b', true]])
  registry.removePermission('a', 'vast.toolbar')
  assert.deepEqual(registry.snapshot().toolbar.map((item) => item.key), ['b:toolbar:open', 'b:toolbar:ping'])
  registry.removeExtension('b')
  assert.equal(registry.ownerFor('b:toolbar:open'), undefined)
  assert.equal(registry.snapshot().commands.length, 1)
})

test('runtime context menus accept explicit contexts and keep v1 items context-free', () => {
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  assert.deepEqual(registry.createContextMenu('a', { id: 'v1', title: 'Old' }), { id: 'v1', title: 'Old' })
  assert.deepEqual(registry.createContextMenu('a', { id: 'v2', title: 'New', contexts: ['link'] }), { id: 'v2', title: 'New', contexts: ['link'] })
  assert.throws(() => registry.createContextMenu('a', { id: 'v3', title: 'Bad', contexts: ['frame'] }), /Invalid context menu contexts/)
})

test('tab-event demand is part of the cached snapshot and only changes emit', () => {
  let emitted = 0
  const registry = new ExtensionContributionRegistry((id) => id, () => { emitted += 1 })
  assert.equal(registry.snapshot().nativeTabEvents, false)
  registry.setTabEventDemand(false)
  assert.equal(emitted, 0)
  registry.setTabEventDemand(true)
  registry.setTabEventDemand(true)
  assert.equal(emitted, 1)
  assert.equal(registry.snapshot().nativeTabEvents, true)
})
