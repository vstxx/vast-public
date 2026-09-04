import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/shared/types.ts', import.meta.url), 'utf8')

test('settings data section exposes full migration actions', () => {
  assert.match(settingsSource, /Current Vast data directory/)
  assert.match(settingsSource, /Export all Vast data/)
  assert.match(settingsSource, /Import Vast data/)
  assert.match(settingsSource, /Change Vast data directory/)
  assert.match(settingsSource, /Open data folder/)
  assert.doesNotMatch(settingsSource, /Create local JSON restore point/)
  assert.doesNotMatch(settingsSource, /This is not a full device migration backup\./)
  assert.match(settingsSource, /Backup report/)
  assert.doesNotMatch(settingsSource, /Create backup now/)
  assert.doesNotMatch(settingsSource, /Migration report/)
})

test('settings full export flushes current renderer state before invoking full backup', () => {
  const helperStart = settingsSource.indexOf('const exportFullBackupFromSettings')
  assert.notEqual(helperStart, -1)
  const helperSource = settingsSource.slice(helperStart, settingsSource.indexOf('const refreshDataPathInfo', helperStart))
  assert.match(helperSource, /window\.vast\.storage\.flush\(state\.toPersistedData\(\)\)/)
  assert.match(helperSource, /return window\.vast\.storage\.exportFullBackup\(\)/)
  assert.ok(helperSource.indexOf('window.vast.storage.flush') < helperSource.indexOf('window.vast.storage.exportFullBackup'))
})

test('legacy JSON import and export options are completely removed from settings', () => {
  assert.doesNotMatch(settingsSource, /Advanced \/ Legacy/)
  assert.doesNotMatch(settingsSource, /Export JSON/)
  assert.doesNotMatch(settingsSource, /Import JSON/)
})

test('developer settings show the installed Vast version', () => {
  assert.match(settingsSource, /window\.vast\.app\.diagnostics\(\)/)
  assert.match(settingsSource, /Vast: \{appVersion\}/)
})

test('preload exposes validated data path and full backup APIs only through IPC', () => {
  for (const channel of [
    'vast:data-path:info',
    'vast:data-path:open',
    'vast:data-path:change',
    'vast:storage:export-full',
    'vast:storage:import-full'
  ]) {
    assert.match(preloadSource, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(typesSource, /DataPathInfo/)
  assert.match(typesSource, /MigrationReport/)
  assert.match(typesSource, /exportFullBackup/)
  assert.match(typesSource, /changeDataDirectory/)
})
