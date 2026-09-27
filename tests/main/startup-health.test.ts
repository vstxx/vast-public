import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StartupHealthTracker } from '../../src/main/startup-health.ts'
import { DEFAULT_DATA } from '../../src/shared/constants.ts'
import type { PersistedData } from '../../src/shared/types.ts'
import { shouldRestoreTabsOnStartup } from '../../src/shared/startup-recovery.ts'

function data(): PersistedData {
  return structuredClone(DEFAULT_DATA)
}

test('startup configures deterministic crash dumps and begins health tracking before app readiness', () => {
  const main = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
  const tracker = readFileSync(new URL('../../src/main/startup-health.ts', import.meta.url), 'utf8')
  assert.ok(main.indexOf('configureVastCrashDumpPath()') < main.indexOf('app.whenReady()'))
  assert.ok(main.indexOf('startupHealth.begin()') < main.indexOf('app.whenReady()'))
  assert.match(tracker, /phase: 'booting'/)
  assert.match(main, /markStable\(\)/)
  assert.match(main, /markCleanExit\(\)/)
})

test('the third launch after two interrupted boots enters safe startup and preserves the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-startup-health-'))
  try {
    assert.deepEqual(await new StartupHealthTracker(root).begin(), { safeStartup: false, consecutiveFailedStartups: 0 })
    assert.deepEqual(await new StartupHealthTracker(root).begin(), { safeStartup: false, consecutiveFailedStartups: 1 })
    const tracker = new StartupHealthTracker(root)
    const recovery = await tracker.begin()
    assert.equal(recovery.safeStartup, true)
    assert.equal(recovery.consecutiveFailedStartups, 2)

    const stored = data()
    stored.tabs = [{
      id: 'bad-tab', workspaceId: stored.activeWorkspaceId, groupId: 'group-recovery',
      title: 'Persisted', url: 'https://chromewebstore.google.com/detail/example', displayUrl: 'chromewebstore.google.com',
      pinned: false, status: 'idle', lifecycle: 'active', progress: 0, canGoBack: false, canGoForward: false,
      createdAt: 1, lastAccessedAt: 1
    }]
    const snapshotPath = await tracker.preserveRecoverySnapshot(stored)
    assert.ok(snapshotPath)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { data: PersistedData }
    assert.equal(snapshot.data.tabs[0]?.id, 'bad-tab')

    const incoming = data()
    incoming.history = [{ id: 'history-new', url: 'https://example.test', title: 'Example', visitedAt: 2 }]
    const merged = tracker.preserveStoredSession(stored, incoming)
    assert.equal(merged.tabs[0]?.id, 'bad-tab')
    assert.equal(merged.history[0]?.id, 'history-new')
    assert.equal(tracker.dataForRenderer(stored).startupRecovery?.safeStartup, true)
    assert.equal(shouldRestoreTabsOnStartup(tracker.dataForRenderer(stored)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a stable or clean startup resets failed-start detection and keeps normal restore enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-startup-stable-'))
  try {
    const first = new StartupHealthTracker(root)
    await first.begin()
    await first.markStable()
    const second = new StartupHealthTracker(root)
    assert.deepEqual(await second.begin(), { safeStartup: false, consecutiveFailedStartups: 0 })
    await second.markCleanExit()
    const third = new StartupHealthTracker(root)
    assert.deepEqual(await third.begin(), { safeStartup: false, consecutiveFailedStartups: 0 })
    const healthyData = data()
    healthyData.settings.startupBehavior = 'restore'
    healthyData.settings.restorePreviousSession = true
    assert.equal(shouldRestoreTabsOnStartup(third.dataForRenderer(healthyData)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
