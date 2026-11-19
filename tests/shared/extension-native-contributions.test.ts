import assert from 'node:assert/strict'
import test from 'node:test'
import { contextMenuApplies, contextMenuClickPayload, parseDeclarativeContributions } from '../../src/shared/extension-native-contributions.ts'
import type { VastNativePermission } from '../../src/shared/extension-native-api.ts'

const all: VastNativePermission[] = ['vast.toolbar', 'vast.commands', 'vast.contextMenus', 'vast.sidebar']
const owner = { permissions: all, hasBackground: true, hasPopup: true }

test('declarative contributions parse into data-only entries and list the assets to verify', () => {
  const { contributions, assets } = parseDeclarativeContributions({
    toolbar: [{ id: 'open', title: ' Open ', icon: 'icons/a.svg', action: 'popup' }],
    commands: [{ id: 'run', title: 'Run', shortcut: 'Ctrl+Shift+Y', action: 'event' }],
    context_menus: [{ id: 'sel', title: 'Use selection', contexts: ['selection', 'link'], action: 'event' }, { id: 'legacy', title: 'Everywhere', action: 'event' }],
    sidebar: [{ id: 'panel', title: 'Panel', page: 'panel.html', icon: 'icons/a.svg' }]
  }, owner)
  assert.deepEqual(contributions.toolbar, [{ id: 'open', title: 'Open', icon: 'icons/a.svg', action: 'popup' }])
  assert.deepEqual(contributions.context_menus.map((item) => item.contexts), [['selection', 'link'], ['all']])
  assert.deepEqual(assets, ['icons/a.svg', 'panel.html', 'icons/a.svg'])
})

test('a manifest declaration is never a grant: each section needs its permission requested', () => {
  assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: 'a', title: 'A', action: 'popup' }] }, { ...owner, permissions: ['vast.commands'] }), /requires the vast\.toolbar permission/)
  // An empty section requests nothing.
  assert.doesNotThrow(() => parseDeclarativeContributions({ toolbar: [] }, { ...owner, permissions: [] }))
})

test('actions are a closed set and must have a receiver', () => {
  for (const action of ['script', 'javascript:alert(1)', 'https://example.com', 'ipc:vast:storage:save', undefined]) {
    assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: 'a', title: 'A', action }] }, owner), /unsupported action/)
  }
  assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: 'a', title: 'A', action: 'event' }] }, { ...owner, hasBackground: false }), /no vast\.background/)
  assert.throws(() => parseDeclarativeContributions({ commands: [{ id: 'a', title: 'A', action: 'popup' }] }, { ...owner, hasPopup: false }), /declares no popup/)
  assert.throws(() => parseDeclarativeContributions({ context_menus: [{ id: 'a', title: 'A', action: 'popup' }] }, owner), /must use action "event"/)
})

test('unknown sections, unknown keys, duplicates and oversize lists are rejected', () => {
  assert.throws(() => parseDeclarativeContributions({ windows: [] }, owner), /not supported/)
  assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: 'a', title: 'A', action: 'popup', onClick: 'x()' }] }, owner), /invalid entry/)
  assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: 'a', title: 'A', action: 'popup' }, { id: 'a', title: 'B', action: 'popup' }] }, owner), /duplicate ID/)
  assert.throws(() => parseDeclarativeContributions({ toolbar: Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, title: 'A', action: 'popup' })) }, owner), /exceeds 5/)
  assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: '../a', title: 'A', action: 'popup' }] }, owner), /invalid or duplicate ID/)
  assert.throws(() => parseDeclarativeContributions([], owner), /must be an object/)
})

test('asset paths stay local, relative and typed', () => {
  for (const icon of ['../outside.svg', '/abs.svg', 'C:/x.svg', 'https://cdn.example/x.svg', 'data:image/svg+xml,<svg/>', 'a\\b.svg', 'a//b.svg', './a.svg', 'script.js']) {
    assert.throws(() => parseDeclarativeContributions({ toolbar: [{ id: 'a', title: 'A', icon, action: 'popup' }] }, owner), /invalid toolbar icon/, icon)
  }
  assert.throws(() => parseDeclarativeContributions({ sidebar: [{ id: 'a', title: 'A', page: 'panel.js' }] }, owner), /invalid side panel page/)
})

test('context filtering follows Chrome semantics and keeps v1 items everywhere', () => {
  const page = { selection: false, link: false }
  const selection = { selection: true, link: false }
  const link = { selection: false, link: true }
  assert.equal(contextMenuApplies(undefined, selection), true)
  assert.equal(contextMenuApplies(['all'], page), true)
  assert.equal(contextMenuApplies(['page'], page), true)
  assert.equal(contextMenuApplies(['page'], selection), false)
  assert.equal(contextMenuApplies(['selection'], selection), true)
  assert.equal(contextMenuApplies(['selection'], link), false)
  assert.equal(contextMenuApplies(['link'], { selection: true, link: true }), true)
})

test('click payloads are bounded, schema-checked and reduced to the declared contexts', () => {
  const click = { tabId: 'tab-1', pageUrl: 'https://example.com/a', linkUrl: 'https://example.com/b', selectionText: 'x'.repeat(5_000) }
  const legacy = contextMenuClickPayload(click, undefined)
  assert.equal(legacy.selectionText?.length, 2_048)
  assert.equal(legacy.linkUrl, 'https://example.com/b')
  assert.deepEqual(contextMenuClickPayload(click, ['selection']), { tabId: 'tab-1', pageUrl: 'https://example.com/a', selectionText: 'x'.repeat(2_048) })
  assert.deepEqual(contextMenuClickPayload(click, ['page']), { tabId: 'tab-1', pageUrl: 'https://example.com/a' })
  // Non-web and credential URLs never reach an extension.
  assert.deepEqual(contextMenuClickPayload({ pageUrl: 'vast://settings', linkUrl: 'https://user:pw@example.com/' }, ['all']), {})
  assert.throws(() => contextMenuClickPayload({ tabId: 'tab-1', cookies: 'x' }, ['all']), /Invalid context menu click/)
  assert.throws(() => contextMenuClickPayload({ tabId: { id: 1 } }, ['all']), /Invalid context menu click/)
  assert.throws(() => contextMenuClickPayload('tab-1', ['all']), /Invalid context menu click/)
})
