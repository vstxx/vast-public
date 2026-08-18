import assert from 'node:assert/strict'
import test from 'node:test'
import type { Tab, Workspace } from '../../src/shared/types.ts'
import { hasPersistedStateChanged, persistedStateChangeToken } from '../../src/renderer/store/persisted-change.ts'

const workspace: Workspace = {
  id: 'w', name: 'Work', icon: 'briefcase', color: '#fff', order: 0, activeTabId: 't', createdAt: 1, updatedAt: 1
}
const tab: Tab = {
  id: 't', workspaceId: 'w', title: 'One', url: 'https://example.com', pinned: false, status: 'idle', lifecycle: 'active',
  progress: 0, canGoBack: false, canGoForward: false, zoom: 1, lastAccessedAt: 1, createdAt: 1
}

function state(currentTab: Tab) {
  return {
    schemaVersion: 1, activeWorkspaceId: 'w', activeSidePanel: 'notes', sidePanelOpen: false, sidebarCollapsed: false,
    focusMode: false, splitView: false, workspaces: [workspace], tabGroups: [], tabs: [currentTab], recentlyClosedTabs: [],
    bookmarks: [], bookmarkFolders: [], history: [], downloads: [], notes: [], readingList: [], macros: [], macroLogs: [],
    sessionSnapshots: [], quickLinks: [], siteMemory: [], todos: [], recentCommandIds: [], settings: {}
  }
}

const download = {
  id: 'd', filename: 'archive.zip', url: 'https://example.com/archive.zip', mimeType: 'application/zip',
  receivedBytes: 1, totalBytes: 100, state: 'progressing' as const, startedAt: 1, updatedAt: 1
}

test('transient webview updates do not schedule persistent storage writes', () => {
  const previous = state(tab)
  assert.equal(hasPersistedStateChanged({ ...previous, tabs: [{ ...tab, progress: 0.7, status: 'loading' }] }, previous), false)
  assert.equal(hasPersistedStateChanged({ ...previous, tabs: [{ ...tab, title: 'New title', favicon: 'https://example.com/icon.png' }] }, previous), false)
  assert.equal(hasPersistedStateChanged({ ...previous, tabs: [{ ...tab, lifecycle: 'crashed' }] }, previous), false)
})

test('navigation and durable tab settings schedule persistence', () => {
  const previous = state(tab)
  assert.equal(hasPersistedStateChanged({ ...previous, tabs: [{ ...tab, url: 'https://example.org' }] }, previous), true)
  assert.notEqual(persistedStateChangeToken({ ...previous, tabs: [{ ...tab, url: 'https://example.org' }] }), persistedStateChangeToken(previous))
  assert.equal(hasPersistedStateChanged({ ...previous, tabs: [{ ...tab, pinned: true }] }, previous), true)
})

test('live download progress is owned by the main-process checkpoint path', () => {
  const previous = { ...state(tab), downloads: [download] }
  const current = {
    ...previous,
    downloads: [{ ...download, receivedBytes: 75, updatedAt: 2 }]
  }
  assert.equal(hasPersistedStateChanged(current, previous), false)
  assert.equal(persistedStateChangeToken(current), persistedStateChangeToken(previous))
})
