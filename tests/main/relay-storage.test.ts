import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRelayInstallId } from '../../src/main/relay/protocol.ts'
import { RelayStateStore } from '../../src/main/relay/storage.ts'

test('Relay generates one random persistent install ID and increments once per service launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-relay-state-'))
  const path = join(root, 'vast-relay-state.json')
  try {
    const store = new RelayStateStore(path)
    const first = await store.beginLaunch(1_786_446_000_000)
    const second = await store.beginLaunch(1_786_446_100_000)
    assert.equal(isRelayInstallId(first.installId), true)
    assert.equal(second.installId, first.installId)
    assert.equal(first.launchCount, 1)
    assert.equal(second.launchCount, 2)
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(raw).sort(), ['dismissed', 'installId', 'launchCount', 'schemaVersion'])
    assert.doesNotMatch(JSON.stringify(raw), /hostname|username|device|hardware|email|url|tab|history|ip/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Relay recovers safely from corrupt local state without deriving machine identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-relay-state-'))
  const path = join(root, 'vast-relay-state.json')
  try {
    await writeFile(path, '{"installId":"windows-sid","launchCount":999}', 'utf8')
    const recovered = await new RelayStateStore(path).beginLaunch(1_786_446_000_000)
    assert.equal(isRelayInstallId(recovered.installId), true)
    assert.equal(recovered.launchCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Relay dismissal state remains local, deduplicated, pruned and bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-relay-state-'))
  const path = join(root, 'vast-relay-state.json')
  const now = 1_786_446_000_000
  try {
    const dismissed = Array.from({ length: 520 }, (_, index) => ({
      id: `broadcast:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      dismissedAt: now - index
    }))
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      installId: '8539ffee-e9f0-4d57-8121-7b1c55fcefe0',
      launchCount: 4,
      dismissed
    }), 'utf8')
    const state = await new RelayStateStore(path).beginLaunch(now)
    assert.equal(state.launchCount, 5)
    assert.equal(state.dismissed.length, 500)
    await assert.rejects(() => new RelayStateStore(path).dismiss('javascript:alert(1)', now), /presentation id/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

