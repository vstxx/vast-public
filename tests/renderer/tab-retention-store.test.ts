import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

// Bundle the real store so this test exercises its Zustand notifications and
// manual unload action, including imports that Node's TS loader cannot resolve.
const require = createRequire(import.meta.url)
const Module = require('node:module')
const entry = fileURLToPath(new URL('../../src/renderer/store/browser-store.ts', import.meta.url))
const code = buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
  logLevel: 'silent'
}).outputFiles[0].text
const compiled = new Module(entry)
compiled.filename = entry
compiled.paths = Module._nodeModulePaths(dirname(entry))
compiled._compile(code, entry)
const store = compiled.exports.useBrowserStore

test('unchanged tab and protection updates do not notify every store subscriber', () => {
  store.setState(store.getInitialState(), true)
  const tab = store.getState().tabs[0]
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications++ })
  store.getState().setKeepAwakeTabIds([])
  store.getState().updateTab(tab.id, { progress: tab.progress })
  store.getState().updateTab('missing-tab', { progress: 0.5 })
  store.getState().updateTabLifecycles([{ id: tab.id, lifecycle: tab.lifecycle }])
  store.getState().swapSplitPanes()
  assert.equal(notifications, 0)
  store.getState().updateTab(tab.id, { progress: 0.5 })
  assert.equal(notifications, 1)
  unsubscribe()
})

test('manual sleep preserves disabled automatic hibernation and tab recency', () => {
  const initial = store.getInitialState()
  const lastAccessedAt = Date.now() - 60_000
  store.setState({
    ...initial,
    settings: { ...initial.settings, hibernateInactiveTabs: false },
    tabs: [
      initial.tabs[0],
      { ...initial.tabs[0], id: 'inactive-web', url: 'https://example.com/', lifecycle: 'active', lastAccessedAt }
    ]
  }, true)
  assert.equal(store.getState().unloadInactiveTabs('sleeping'), 1)
  assert.equal(store.getState().settings.hibernateInactiveTabs, false)
  assert.equal(store.getState().tabs[1].lifecycle, 'sleeping')
  assert.equal(store.getState().tabs[1].lastAccessedAt, lastAccessedAt)

  assert.equal(store.getState().unloadInactiveTabs('discarded'), 1)
  assert.equal(store.getState().settings.hibernateInactiveTabs, false)
  assert.equal(store.getState().tabs[1].lifecycle, 'discarded')
  assert.ok(store.getState().tabs[1].lastAccessedAt < lastAccessedAt)
  store.setState(initial, true)
})
