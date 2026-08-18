import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  prepareLegacyDefaultSessionFiles,
  readLegacySessionMigrationMarker,
  writeLegacySessionMigrationMarker
} from '../../src/main/session-continuity-files.ts'

function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'vast-session-continuity-'))
}

test('legacy default website stores are staged into the new persistent partition', () => {
  const root = tempProfile()
  try {
    mkdirSync(join(root, 'Network'), { recursive: true })
    mkdirSync(join(root, 'Local Storage', 'leveldb'), { recursive: true })
    writeFileSync(join(root, 'Network', 'Cookies'), 'legacy-cookie-db')
    writeFileSync(join(root, 'Local Storage', 'leveldb', '000001.log'), 'legacy-storage')

    const plan = prepareLegacyDefaultSessionFiles(root)

    assert.equal(plan.needed, true)
    assert.deepEqual(plan.copiedItems.sort(), ['Local Storage', 'Network'])
    assert.equal(readFileSync(join(plan.targetRoot, 'Network', 'Cookies'), 'utf8'), 'legacy-cookie-db')
    assert.equal(readFileSync(join(plan.targetRoot, 'Local Storage', 'leveldb', '000001.log'), 'utf8'), 'legacy-storage')
    assert.equal(existsSync(plan.markerPath), false, 'marker waits for the cookie API merge')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing target stores win while missing legacy stores are still copied', () => {
  const root = tempProfile()
  try {
    const target = join(root, 'Partitions', 'vast-default')
    mkdirSync(join(root, 'Network'), { recursive: true })
    mkdirSync(join(root, 'IndexedDB'), { recursive: true })
    mkdirSync(join(target, 'Network'), { recursive: true })
    writeFileSync(join(root, 'Network', 'Cookies'), 'legacy-cookie-db')
    writeFileSync(join(root, 'IndexedDB', 'legacy.db'), 'legacy-indexed-db')
    writeFileSync(join(target, 'Network', 'Cookies'), 'current-cookie-db')

    const plan = prepareLegacyDefaultSessionFiles(root)

    assert.deepEqual(plan.preservedTargetItems, ['Network'])
    assert.deepEqual(plan.copiedItems, ['IndexedDB'])
    assert.equal(readFileSync(join(target, 'Network', 'Cookies'), 'utf8'), 'current-cookie-db')
    assert.equal(readFileSync(join(target, 'IndexedDB', 'legacy.db'), 'utf8'), 'legacy-indexed-db')

    writeLegacySessionMigrationMarker(plan, { importedCookies: 3 })
    assert.equal((readLegacySessionMigrationMarker(plan.markerPath) as { importedCookies: number }).importedCookies, 3)
    assert.equal(prepareLegacyDefaultSessionFiles(root).needed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a profile without legacy website data is marked complete without creating a partition', () => {
  const root = tempProfile()
  try {
    writeFileSync(join(root, 'vast-data.json'), '{}')
    const plan = prepareLegacyDefaultSessionFiles(root)
    assert.equal(plan.needed, false)
    assert.equal(existsSync(plan.markerPath), true)
    assert.equal(existsSync(plan.targetRoot), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
