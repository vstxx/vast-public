import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  migrateLegacyInternalTab,
  migrateLegacyInternalUrl,
  migrateLegacySessionSnapshot
} from '../../src/shared/legacy-internal-url-migration.ts'

test('legacy upgrade cards migrate to new tabs across persisted tab collections', () => {
  assert.equal(migrateLegacyInternalUrl('vast://upgrade'), 'vast://newtab')
  assert.equal(migrateLegacyInternalUrl('vast://reader'), 'vast://newtab')
  assert.deepEqual(
    migrateLegacyInternalTab({ id: 'tab', title: 'Upgrade', url: 'vast://upgrade' }),
    { id: 'tab', title: 'New tab', url: 'vast://newtab' }
  )
  assert.deepEqual(
    migrateLegacyInternalTab({ id: 'media', title: 'Avidae', url: 'vast://avidae' }),
    { id: 'media', title: 'Video & Audio', url: 'vast://avidae' }
  )
  assert.deepEqual(
    migrateLegacyInternalTab({ id: 'reader', title: 'Focus Reader', url: 'vast://reader', readerMode: true }),
    { id: 'reader', title: 'New tab', url: 'vast://newtab' }
  )
  assert.deepEqual(
    migrateLegacySessionSnapshot({
      id: 'snapshot',
      activeUrl: 'vast://upgrade',
      tabs: [{ title: 'Upgrade', url: 'vast://upgrade', pinned: false }]
    }),
    {
      id: 'snapshot',
      activeUrl: 'vast://newtab',
      tabs: [{ title: 'New tab', url: 'vast://newtab', pinned: false }]
    }
  )
})

test('storage migration applies URL and privacy migrations to all saved data using schema 8', () => {
  const storageSource = readFileSync(new URL('../../src/main/storage.ts', import.meta.url), 'utf8')
  const constantsSource = readFileSync(new URL('../../src/shared/constants.ts', import.meta.url), 'utf8')
  assert.match(storageSource, /merged\.tabs[\s\S]*\.map\(migrateLegacyInternalTab\)/)
  assert.match(storageSource, /merged\.recentlyClosedTabs[\s\S]*\.map\(migrateLegacyInternalTab\)/)
  assert.match(storageSource, /merged\.sessionSnapshots[\s\S]*\.map\(migrateLegacySessionSnapshot\)/)
  assert.match(constantsSource, /STORAGE_SCHEMA_VERSION = 8/)
  assert.match(storageSource, /adBlockerMode === 'soft'/)
  assert.match(storageSource, /adBlockerMode === 'brutal'/)
  assert.match(storageSource, /sessionMode: workspace\.isPrivate \? 'ephemeral' : 'isolated'/)
})
