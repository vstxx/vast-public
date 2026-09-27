import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DATA, INTERNAL_NEW_TAB_URL, INTERNAL_ONBOARDING_URL } from '../../src/shared/constants.ts'
import { onboardingDefaultChoices, ONBOARDING_ACCENTS, ONBOARDING_RADIUS_MAX, ONBOARDING_RADIUS_MIN, onboardingCompleted } from '../../src/shared/onboarding.ts'
import type { PersistedData, Tab, Workspace } from '../../src/shared/types.ts'
import { mergeImportedEntries } from '../../src/renderer/store/imported-data-merge.ts'
import { applyOnboardingStart } from '../../src/renderer/store/onboarding-hydration.ts'

const workspace: Workspace = {
  id: 'workspace-default',
  name: 'Workspace',
  icon: 'Globe2',
  color: '#d1a3ff',
  order: 0,
  activeTabId: 'tab-1',
  createdAt: 1,
  updatedAt: 1
}

function restoredTab(id: string, url: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    workspaceId: workspace.id,
    title: 'Tab',
    url,
    pinned: false,
    status: 'idle',
    lifecycle: 'active',
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    lastAccessedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

function persistedWith(partial: Partial<PersistedData>): PersistedData {
  return { ...structuredClone(DEFAULT_DATA), ...partial }
}

test('onboarding defaults are sourced from DEFAULT_SETTINGS, never hardcoded', () => {
  const defaults = onboardingDefaultChoices()
  assert.equal(defaults.theme, DEFAULT_DATA.settings.theme)
  assert.equal(defaults.accentColor, DEFAULT_DATA.settings.accentColor)
  assert.equal(defaults.cornerRadius, DEFAULT_DATA.settings.appearance.cornerRadius)
  assert.equal(defaults.defaultSearchEngine, DEFAULT_DATA.settings.defaultSearchEngine)
  assert.equal(defaults.newTabBackground, DEFAULT_DATA.settings.newTab.background)
  assert.ok(ONBOARDING_RADIUS_MIN >= 6, 'onboarding radius range stays inside the appearance clamp')
  assert.ok(ONBOARDING_RADIUS_MAX <= 36)
  assert.ok(ONBOARDING_ACCENTS.some((accent) => accent.value === DEFAULT_DATA.settings.accentColor))
})

test('onboardingCompleted reads the optional persisted field defensively', () => {
  assert.equal(onboardingCompleted({}), false)
  assert.equal(onboardingCompleted({ onboarding: { completed: false } }), false)
  assert.equal(onboardingCompleted({ onboarding: { completed: true } }), true)
})

test('a fresh profile routes its initial tab to vast://onboarding', () => {
  const data = persistedWith({ onboarding: { completed: false } })
  const tabs = data.tabs.map((tab) => ({ ...tab, id: 'tab-1' }))
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-1' }, onboardingCompleted: false })
  assert.equal(next.length, 1, 'no extra tab is created')
  assert.equal(next[0]?.url, INTERNAL_ONBOARDING_URL)
  assert.equal(next[0]?.title, 'Onboarding')
})

test('a completed profile is never sent through onboarding again', () => {
  const data = persistedWith({ onboarding: { completed: true } })
  const tabs = data.tabs.map((tab) => ({ ...tab, id: 'tab-1', url: INTERNAL_NEW_TAB_URL }))
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-1' }, onboardingCompleted: true })
  assert.equal(next[0]?.url, INTERNAL_NEW_TAB_URL)
})

test('an interrupted onboarding resumes on the onboarding tab, predictable and singular', () => {
  const tabs = [
    restoredTab('tab-1', 'https://github.com/'),
    restoredTab('tab-2', INTERNAL_ONBOARDING_URL),
    restoredTab('tab-3', 'https://example.com/')
  ]
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-3' }, onboardingCompleted: false })
  assert.equal(next.filter((tab) => tab.url === INTERNAL_ONBOARDING_URL).length, 1, 'existing onboarding tab is reused')
  assert.equal(next.find((tab) => tab.id === 'tab-1')?.url, 'https://github.com/', 'other restored tabs are untouched')
  assert.equal(next.find((tab) => tab.id === 'tab-3')?.url, 'https://example.com/', 'active tab untouched when an onboarding tab exists')
})

test('pinned active tabs are not hijacked for onboarding', () => {
  const tabs = [restoredTab('tab-1', 'https://github.com/', { pinned: true })]
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-1' }, onboardingCompleted: false })
  assert.equal(next[0]?.url, 'https://github.com/')
})

test('imported bookmarks merge into Vast models with honest counts and dedup', () => {
  const current = {
    bookmarks: [{ id: 'bm-1', title: 'Keep', url: 'https://github.com/', createdAt: 1, updatedAt: 1 }],
    bookmarkFolders: [],
    history: []
  }
  const result = mergeImportedEntries(current, {
    bookmarks: [
      { title: 'GitHub', url: 'https://github.com/', folderPath: [] },
      { title: 'Docs', url: 'https://docs.vastbrowser.com/', folderPath: ['Imported', 'Dev'] },
      { title: 'Docs again', url: 'https://docs.vastbrowser.com/', folderPath: ['Other'] },
      { title: '', url: 'https://example.net/page', folderPath: [] }
    ],
    history: [
      { title: 'Example', url: 'https://example.com/', visitCount: 3, lastVisitedAt: 500 },
      { title: 'Example', url: 'https://example.com/', visitCount: 2, lastVisitedAt: 900 }
    ]
  })

  assert.equal(result.bookmarksAdded, 2, 'existing url + intra-import duplicate collapse')
  assert.equal(result.foldersCreated, 2, 'Imported and Imported/Dev are created once')
  assert.equal(result.bookmarks.length, 3)
  const docs = result.bookmarks.find((bookmark) => bookmark.url === 'https://docs.vastbrowser.com/')
  assert.ok(docs?.folderId)
  const devFolder = result.bookmarkFolders.find((folder) => folder.id === docs?.folderId)
  assert.equal(devFolder?.name, 'Dev')
  const importedFolder = result.bookmarkFolders.find((folder) => folder.id === devFolder?.parentId)
  assert.equal(importedFolder?.name, 'Imported')
  const untitled = result.bookmarks.find((bookmark) => bookmark.url === 'https://example.net/page')
  assert.ok(untitled?.title, 'a title fallback is derived for untitled entries')

  assert.equal(result.historyAdded, 1)
  assert.equal(result.history[0]?.visitCount, 5, 'duplicate history entries merge visit counts')
  assert.equal(result.history[0]?.lastVisitedAt, 900)
})

test('merging imported data preserves sibling state and pre-existing entries', () => {
  const current = {
    bookmarks: [{ id: 'bm-keep', title: 'Keep', url: 'https://keep.example/', createdAt: 1, updatedAt: 1 }],
    bookmarkFolders: [{ id: 'folder-keep', name: 'Keep', order: 0, createdAt: 1 }],
    history: [{ id: 'h-keep', title: 'Keep', url: 'https://keep.example/', visitCount: 1, lastVisitedAt: 10 }]
  }
  const result = mergeImportedEntries(current, {
    bookmarks: [{ title: 'New', url: 'https://new.example/', folderPath: [] }],
    history: []
  })
  assert.ok(result.bookmarks.some((bookmark) => bookmark.id === 'bm-keep'))
  assert.ok(result.bookmarkFolders.some((folder) => folder.id === 'folder-keep'))
  assert.ok(result.history.some((entry) => entry.id === 'h-keep'))
  assert.equal(result.historyAdded, 0)
  assert.equal(result.foldersCreated, 0)
})

test('merging history sorts by recency and keeps the newest 1000 entries', () => {
  const current = { bookmarks: [], bookmarkFolders: [], history: [{ id: 'h-old', title: 'Old', url: 'https://old.example/', visitCount: 1, lastVisitedAt: 5 }] }
  const importedHistory = Array.from({ length: 1_100 }, (_item, index) => ({
    title: `Site ${index}`,
    url: `https://site-${index}.example/`,
    visitCount: 1,
    lastVisitedAt: 1_000 + index
  }))
  const result = mergeImportedEntries(current, { bookmarks: [], history: importedHistory })
  assert.equal(result.history.length, 1_000)
  assert.equal(result.history[0]?.url, 'https://site-1099.example/')
  assert.equal(result.historyAdded, 1_100)
})
