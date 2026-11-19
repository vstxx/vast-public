import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

import { mergeRestoredHistory, selectHistoryIds, historyHost, historyMatchesQuery } from '../../src/renderer/lib/history-deletion.ts'
import type { HistoryEntry } from '../../src/shared/types.ts'

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

const HOUR = 60 * 60 * 1000
const now = Date.UTC(2026, 9, 27, 12)

function visit(id: string, url: string, hoursAgo: number, workspaceId = 'workspace-default', title = id): HistoryEntry {
  return { id, title, url, visitCount: 1, lastVisitedAt: now - hoursAgo * HOUR, workspaceId }
}

const sample: HistoryEntry[] = [
  visit('a', 'https://www.example.com/one', 0.5, 'workspace-default', 'Example one'),
  visit('b', 'https://example.com/two', 5),
  visit('c', 'https://news.test/story', 30, 'workspace-work', 'Źródło news'),
  visit('d', 'https://docs.test/', 24 * 10),
  visit('e', 'https://old.test/', 24 * 60)
]

test('history selection by time range, host, query, ids and workspace', () => {
  assert.deepEqual(selectHistoryIds(sample, { range: 'hour' }, now), ['a'])
  assert.deepEqual(selectHistoryIds(sample, { range: 'day' }, now), ['a', 'b'])
  assert.deepEqual(selectHistoryIds(sample, { range: 'week' }, now), ['a', 'b', 'c'])
  assert.deepEqual(selectHistoryIds(sample, { range: 'month' }, now), ['a', 'b', 'c', 'd'])
  assert.deepEqual(selectHistoryIds(sample, { range: 'all' }, now), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(selectHistoryIds(sample, { host: 'example.com' }, now), ['a', 'b'], 'www. is part of the same site')
  assert.deepEqual(selectHistoryIds(sample, { query: 'zrodlo' }, now), ['c'], 'diacritic-insensitive query')
  assert.deepEqual(selectHistoryIds(sample, { ids: ['d', 'missing'] }, now), ['d'])
  assert.deepEqual(selectHistoryIds(sample, { range: 'all', workspaceId: 'workspace-work' }, now), ['c'])
  assert.equal(historyHost('not a url'), '')
  assert.equal(historyMatchesQuery(sample[0], ''), true)
})

test('undo restores removed entries without duplicating pages visited again', () => {
  const revisited = { ...sample[0], id: 'a2', lastVisitedAt: now, visitCount: 3 }
  const merged = mergeRestoredHistory([revisited, sample[1]], [sample[0], sample[3]])
  assert.deepEqual(merged.map((item) => item.id), ['a2', 'b', 'd'])
  assert.equal(merged[0].visitCount, 3)
})

test('store removes history entries, returns them for undo and restores them in order', () => {
  store.setState(store.getInitialState(), true)
  store.setState({ history: sample })
  const removed = store.getState().removeHistoryEntries(['b', 'd'])
  assert.deepEqual(removed.map((item: HistoryEntry) => item.id), ['b', 'd'])
  assert.deepEqual(store.getState().history.map((item: HistoryEntry) => item.id), ['a', 'c', 'e'])
  assert.deepEqual(store.getState().removeHistoryEntries(['missing']), [])
  store.getState().restoreHistoryEntries(removed)
  assert.deepEqual(store.getState().history.map((item: HistoryEntry) => item.id), ['a', 'b', 'c', 'd', 'e'])
})

function withOnboardingTab(): string {
  store.setState(store.getInitialState(), true)
  const state = store.getState()
  const tabId = state.tabs[0].id
  store.setState({
    onboarding: { completed: false, revision: 1 },
    tabs: state.tabs.map((tab: { id: string }) => (tab.id === tabId ? { ...tab, url: 'vast://onboarding' } : tab))
  })
  return tabId
}

test('navigating the onboarding tab elsewhere dismisses onboarding for good', () => {
  const tabId = withOnboardingTab()
  store.getState().navigateTab(tabId, 'https://example.com/')
  assert.deepEqual(store.getState().onboarding, { completed: true, revision: 1 })
})

test('closing the onboarding tab dismisses onboarding for good', () => {
  const tabId = withOnboardingTab()
  store.getState().createTab({ url: 'https://example.com/' })
  store.getState().closeTab(tabId)
  assert.equal(store.getState().onboarding.completed, true)
})

test('ordinary navigation and other tabs never complete onboarding', () => {
  const tabId = withOnboardingTab()
  store.getState().navigateTab(tabId, 'vast://onboarding')
  assert.equal(store.getState().onboarding.completed, false)
  const other = store.getState().tabs.find((tab: { id: string }) => tab.id !== tabId)
  if (other) {
    store.getState().navigateTab(other.id, 'https://example.com/')
    assert.equal(store.getState().onboarding.completed, false)
  }
})

test('completing onboarding records the current state revision', () => {
  withOnboardingTab()
  store.getState().completeOnboarding()
  assert.deepEqual(store.getState().onboarding, { completed: true, revision: 1 })
})
