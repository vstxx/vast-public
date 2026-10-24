import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { hasPersistedStateChanged } from '../../src/renderer/store/persisted-change.ts'

// Bundle the real store so the test exercises its actual Zustand reducers.
const require = createRequire(import.meta.url)
const Module = require('node:module')
const entry = fileURLToPath(new URL('../../src/renderer/store/browser-store.ts', import.meta.url))
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' }).outputFiles[0].text
const compiled = new Module(entry)
compiled.filename = entry
compiled.paths = Module._nodeModulePaths(dirname(entry))
compiled._compile(code, entry)
const store = compiled.exports.useBrowserStore

const origin = 'https://mail.example.com'
const site = { hostname: 'mail.example.com', title: '(3) Inbox', favicon: 'https://mail.example.com/favicon.ico', lastUrl: `${origin}/inbox`, zoom: 1, muted: undefined }

function reset(): void {
  store.setState(store.getInitialState(), true)
  store.getState().upsertSiteMemory(origin, { ...site, visited: true })
}

test('repeating stored site values keeps the same state and does not schedule a save', () => {
  reset()
  const before = store.getState()
  const entryBefore = before.siteMemory.find((item: { origin: string }) => item.origin === origin)
  store.getState().upsertSiteMemory(origin, { ...site })
  store.getState().upsertSiteMemory(origin, { hostname: undefined, zoom: 1 })
  const after = store.getState()
  assert.equal(after, before, 'no store notification for a no-op')
  assert.equal(after.siteMemory, before.siteMemory)
  assert.equal(after.siteMemory.find((item: { origin: string }) => item.origin === origin).updatedAt, entryBefore.updatedAt)
  assert.equal(hasPersistedStateChanged(after, before), false)
})

test('real changes and visits still update site memory and its recency', () => {
  reset()
  const before = store.getState()
  const visitsBefore = before.siteMemory[0].visitCount
  store.getState().upsertSiteMemory(origin, { ...site, favicon: 'https://mail.example.com/unread.ico' })
  const changed = store.getState()
  assert.notEqual(changed.siteMemory, before.siteMemory)
  assert.equal(changed.siteMemory[0].favicon, 'https://mail.example.com/unread.ico')
  assert.equal(hasPersistedStateChanged(changed, before), true)

  store.getState().upsertSiteMemory(origin, { ...site, favicon: 'https://mail.example.com/unread.ico', visited: true })
  const visited = store.getState()
  assert.equal(visited.siteMemory[0].visitCount, visitsBefore + 1, 'a visit is always recorded, even with identical values')
  assert.ok(visited.siteMemory[0].lastUsedAt >= changed.siteMemory[0].lastUsedAt)

  store.getState().upsertSiteMemory(origin, { zoom: 1.25 })
  assert.equal(store.getState().siteMemory[0].zoom, 1.25)
  store.getState().upsertSiteMemory(origin, { muted: true })
  assert.equal(store.getState().siteMemory[0].muted, true)
})

test('clearing a stored value is a change', () => {
  reset()
  store.getState().upsertSiteMemory(origin, { muted: true })
  const before = store.getState()
  store.getState().upsertSiteMemory(origin, { muted: undefined })
  assert.notEqual(store.getState().siteMemory, before.siteMemory)
  assert.equal(store.getState().siteMemory[0].muted, undefined)
})

test('a new origin is always stored', () => {
  reset()
  const before = store.getState()
  store.getState().upsertSiteMemory('https://new.example.com', { hostname: 'new.example.com' })
  assert.equal(store.getState().siteMemory.length, before.siteMemory.length + 1)
})

test('live title changes update the tab but are not written to site memory', () => {
  const source = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
  const onTitle = source.slice(source.indexOf('const onTitle = '), source.indexOf('const onFavicon = '))
  assert.match(onTitle, /updateTab\(tab\.id, \{ title \}\)/)
  assert.doesNotMatch(onTitle, /rememberCurrentSite/)
  // Recorded from the main process's navigation state (no synchronous webview reads).
  const onState = source.slice(source.indexOf('const onNavigationState = '), source.indexOf('const onTitle = '))
  assert.match(onState, /state\.reason === 'stop'\) \{\s+rememberCurrentSite\(\{ url: state\.url, title: state\.title, visited: true \}\)/, 'the title is still captured when a load finishes')
  assert.match(onState, /state\.reason === 'navigate'\) \{[\s\S]*?rememberCurrentSite\(\{ url: state\.url, title: state\.title \}\)/, 'navigations still refresh site memory')
})
