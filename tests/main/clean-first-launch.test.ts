import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DATA, DEFAULT_SETTINGS, INTERNAL_NEW_TAB_URL, STORAGE_SCHEMA_VERSION } from '../../src/shared/constants.ts'
import type { PersistedData } from '../../src/shared/types.ts'
import { mergePersistedDataForMigration } from '../../src/shared/storage-schema-migration.ts'

test('a fresh profile is a clean, silent, single-workspace launch', () => {
  assert.equal(DEFAULT_DATA.schemaVersion, STORAGE_SCHEMA_VERSION)
  assert.equal(DEFAULT_DATA.workspaces.length, 1)
  assert.equal(DEFAULT_DATA.tabs.length, 1)
  assert.equal(DEFAULT_DATA.tabs[0]?.url, INTERNAL_NEW_TAB_URL)
  assert.equal(DEFAULT_DATA.tabs[0]?.workspaceId, DEFAULT_DATA.workspaces[0]?.id)
  assert.equal(DEFAULT_DATA.activeWorkspaceId, DEFAULT_DATA.workspaces[0]?.id)
  assert.equal(DEFAULT_DATA.workspaces[0]?.activeTabId, DEFAULT_DATA.tabs[0]?.id)
  assert.deepEqual(DEFAULT_DATA.tabGroups, [])
  assert.deepEqual(DEFAULT_DATA.bookmarks, [])
  assert.deepEqual(DEFAULT_DATA.bookmarkFolders, [])
  assert.deepEqual(DEFAULT_DATA.notes, [])
  assert.deepEqual(DEFAULT_DATA.todos, [])
  assert.deepEqual(DEFAULT_DATA.macros, [])
  assert.deepEqual(DEFAULT_DATA.macroLogs, [])
  assert.deepEqual(DEFAULT_DATA.sessionSnapshots, [])
  assert.deepEqual(DEFAULT_DATA.history, [])
  assert.equal(DEFAULT_DATA.sidePanelOpen, false)
  assert.equal(DEFAULT_DATA.sidebarCollapsed, true)
  assert.equal(DEFAULT_SETTINGS.openingAnimationSoundVolume, 0)
  assert.equal(DEFAULT_SETTINGS.labs.enabled, false)
  assert.equal(DEFAULT_SETTINGS.newTabBehavior, 'search')
  assert.equal(DEFAULT_DATA.quickLinks.length <= 3, true)
  assert.deepEqual(
    Object.entries(DEFAULT_SETTINGS.newTab)
      .filter(([key, value]) => key.startsWith('show') && key !== 'showQuickLinks' && value)
      .map(([key]) => key),
    []
  )
})

test('schema 8 migration base preserves existing user data and preferences', () => {
  const existing = structuredClone(DEFAULT_DATA) as PersistedData
  existing.schemaVersion = 7
  existing.workspaces[0].name = 'Existing workspace'
  existing.sidebarCollapsed = false
  existing.sidePanelOpen = true
  existing.settings.openingAnimationSoundVolume = 85
  existing.settings.labs = {
    enabled: true,
    avidae: true,
    networkDevices: true,
    automation: true,
    passwordManager: true,
    advancedDiagnostics: true,
    spoofing: true
  }
  existing.notes = [{
    id: 'existing-note',
    title: 'Keep me',
    body: 'Existing local content',
    workspaceId: existing.workspaces[0].id,
    createdAt: 1,
    updatedAt: 2
  }]
  existing.quickLinks = [{ id: 'custom-link', title: 'Custom', url: 'https://example.com', color: '#123456' }]

  const migrated = mergePersistedDataForMigration(structuredClone(DEFAULT_DATA), existing, STORAGE_SCHEMA_VERSION)

  assert.equal(migrated.schemaVersion, STORAGE_SCHEMA_VERSION)
  assert.equal(migrated.workspaces[0]?.name, 'Existing workspace')
  assert.equal(migrated.notes[0]?.id, 'existing-note')
  assert.equal(migrated.quickLinks[0]?.id, 'custom-link')
  assert.equal(migrated.sidebarCollapsed, false)
  assert.equal(migrated.sidePanelOpen, true)
  assert.equal(migrated.settings.openingAnimationSoundVolume, 85)
  assert.deepEqual(migrated.settings.labs, existing.settings.labs)
})
