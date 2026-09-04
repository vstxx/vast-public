import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RelayClientSnapshot, RelaySignedEnvelope } from '../../src/shared/relay-types.ts'
import { VastRelayService, RELAY_STARTUP_DELAY_MS } from '../../src/main/relay/service.ts'
import { RelayStateStore } from '../../src/main/relay/storage.ts'
import { relayBroadcastFixture, relayFixtureKeys, relayReleaseFixture, RELAY_FIXTURE_NOW } from './relay-fixtures.ts'

interface ScheduledJob {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

class FakeScheduler {
  readonly jobs: ScheduledJob[] = []

  schedule(callback: () => void, delayMs: number): { cancel(): void } {
    const job = { callback, delayMs, cancelled: false }
    this.jobs.push(job)
    return { cancel: () => { job.cancelled = true } }
  }

  runNext(): ScheduledJob {
    const job = this.jobs.shift()
    if (!job) throw new Error('No Relay job was scheduled.')
    if (!job.cancelled) job.callback()
    return job
  }

  nextActive(): ScheduledJob | undefined {
    return this.jobs.find((job) => !job.cancelled)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Relay test state.')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function emptyResponse() {
  return { protocol: 1, server_time: '2026-08-11T12:00:00.000Z', messages: [], update: null }
}

async function withRelayStore(run: (path: string, store: RelayStateStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vast-relay-service-'))
  const path = join(root, 'vast-relay-state.json')
  try {
    await run(path, new RelayStateStore(path))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('Relay starts after the usable shell, reports its instance kind, and schedules six-hour checks', async () => {
  await withRelayStore(async (statePath, stateStore) => {
    const scheduler = new FakeScheduler()
    let request: RequestInit | undefined
    let requestUrl = ''
    let emitted: RelayClientSnapshot | undefined
    const service = new VastRelayService({
      config: { enabled: true, environment: 'staging', endpoint: 'https://relay-staging.vastbrowser.com', keys: [] },
      stateStore,
      fetcher: async (input, init) => {
        requestUrl = String(input)
        request = init
        return jsonResponse(emptyResponse())
      },
      currentVersion: () => '0.1.4',
      instanceKind: 'test',
      emitSnapshot: (snapshot) => { emitted = snapshot },
      openExternal: async () => undefined,
      applyTrustedUpdate: async () => false,
      now: () => RELAY_FIXTURE_NOW,
      random: () => 0.5,
      scheduler
    })

    await service.start()
    await service.start()
    assert.equal(scheduler.nextActive()?.delayMs, RELAY_STARTUP_DELAY_MS)
    scheduler.runNext()
    await waitFor(() => Boolean(request && emitted))

    assert.equal(requestUrl, 'https://relay-staging.vastbrowser.com/v1/checkin')
    assert.equal(request?.method, 'POST')
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>
    assert.deepEqual(Object.keys(body).sort(), ['current_version', 'install_id', 'instance_kind', 'launch_count', 'protocol'])
    assert.equal(body.protocol, 1)
    assert.equal(body.current_version, '0.1.4')
    assert.equal(body.launch_count, 1)
    assert.equal(body.instance_kind, 'test')
    assert.equal(typeof body.install_id, 'string')
    assert.equal(scheduler.nextActive()?.delayMs, 6 * 60 * 60 * 1_000)
    assert.equal(emitted?.current, null)

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { launchCount: number }
    assert.equal(persisted.launchCount, 1)
    service.stop()
  })
})

test('Relay-disabled stable builds maintain local launch semantics without making a request', async () => {
  await withRelayStore(async (statePath, stateStore) => {
    const scheduler = new FakeScheduler()
    let requests = 0
    const service = new VastRelayService({
      config: { enabled: false, environment: 'production', endpoint: 'https://relay.vastbrowser.com', keys: [] },
      stateStore,
      fetcher: async () => { requests += 1; return jsonResponse(emptyResponse()) },
      currentVersion: () => '0.1.4',
      instanceKind: 'test',
      emitSnapshot: () => undefined,
      openExternal: async () => undefined,
      applyTrustedUpdate: async () => false,
      now: () => RELAY_FIXTURE_NOW,
      scheduler
    })
    await service.start()
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { launchCount: number; installId: string }
    assert.equal(persisted.launchCount, 1)
    assert.match(persisted.installId, /^[0-9a-f-]{36}$/)
    assert.equal(requests, 0)
    assert.equal(scheduler.nextActive(), undefined)
    service.stop()
  })
})

test('Relay outage, HTTP 500 and 429 retry conservatively while 4xx schema failures do not hammer', async () => {
  const cases = [
    { response: () => Promise.reject(new Error('offline')), expected: 60_000 },
    { response: () => Promise.resolve(jsonResponse({}, 500)), expected: 60_000 },
    { response: () => Promise.resolve(jsonResponse({}, 503, { 'Retry-After': '600' })), expected: 600_000 },
    { response: () => Promise.resolve(jsonResponse({}, 429, { 'Retry-After': '600' })), expected: 600_000 },
    { response: () => Promise.resolve(jsonResponse({}, 400)), expected: 6 * 60 * 60 * 1_000 },
    { response: () => Promise.resolve(jsonResponse({ ...emptyResponse(), unexpected: true })), expected: 6 * 60 * 60 * 1_000 },
    { response: () => Promise.resolve(jsonResponse({ ...emptyResponse(), protocol: 2 })), expected: 6 * 60 * 60 * 1_000 },
    { response: () => Promise.resolve(new Response('{malformed', { headers: { 'Content-Type': 'application/json' } })), expected: 6 * 60 * 60 * 1_000 },
    { response: () => Promise.resolve(new Response('', { headers: { 'Content-Type': 'application/json' } })), expected: 6 * 60 * 60 * 1_000 }
  ]
  for (const scenario of cases) {
    await withRelayStore(async (_path, stateStore) => {
      const scheduler = new FakeScheduler()
      const service = new VastRelayService({
        config: { enabled: true, environment: 'staging', endpoint: 'https://relay-staging.vastbrowser.com', keys: [] },
        stateStore,
        fetcher: scenario.response,
        currentVersion: () => '0.1.4',
        instanceKind: 'test',
        emitSnapshot: () => undefined,
        openExternal: async () => undefined,
        applyTrustedUpdate: async () => false,
        now: () => RELAY_FIXTURE_NOW,
        random: () => 0.5,
        scheduler
      })
      await service.start()
      scheduler.runNext()
      await waitFor(() => scheduler.nextActive()?.delayMs === scenario.expected)
      assert.equal(scheduler.nextActive()?.delayMs, scenario.expected)
      service.stop()
    })
  }
})

test('Relay aborts a stalled check-in without affecting the application lifecycle', async () => {
  await withRelayStore(async (_path, stateStore) => {
    const scheduler = new FakeScheduler()
    const service = new VastRelayService({
      config: { enabled: true, environment: 'staging', endpoint: 'https://relay-staging.vastbrowser.com', keys: [] },
      stateStore,
      fetcher: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
      currentVersion: () => '0.1.4',
      instanceKind: 'test',
      emitSnapshot: () => undefined,
      openExternal: async () => undefined,
      applyTrustedUpdate: async () => false,
      checkinTimeoutMs: 10,
      now: () => RELAY_FIXTURE_NOW,
      random: () => 0.5,
      scheduler
    })
    await service.start()
    scheduler.runNext()
    await waitFor(() => scheduler.nextActive()?.delayMs === 60_000)
    service.stop()
  })
})

test('Relay drops tampered messages and exposes only verified passive presentation data', async () => {
  await withRelayStore(async (_path, stateStore) => {
    const scheduler = new FakeScheduler()
    const keys = relayFixtureKeys()
    const valid = keys.signPayload(relayBroadcastFixture({ media: null }))
    const tampered: RelaySignedEnvelope<typeof valid.payload> = {
      ...valid,
      payload: { ...valid.payload, title: 'Tampered title' }
    }
    const snapshots: RelayClientSnapshot[] = []
    let responseMessages = [tampered]
    const service = new VastRelayService({
      config: { enabled: true, environment: 'staging', endpoint: 'https://relay-staging.vastbrowser.com', keys: [keys.trust] },
      stateStore,
      fetcher: async () => jsonResponse({ ...emptyResponse(), messages: responseMessages }),
      currentVersion: () => '0.1.4',
      instanceKind: 'test',
      emitSnapshot: (snapshot) => snapshots.push(snapshot),
      openExternal: async () => undefined,
      applyTrustedUpdate: async () => false,
      now: () => RELAY_FIXTURE_NOW,
      random: () => 0.5,
      scheduler
    })
    await service.start()
    scheduler.runNext()
    await waitFor(() => snapshots.length === 1)
    assert.equal(snapshots.at(-1)?.current, null)

    responseMessages = [valid]
    scheduler.runNext()
    await waitFor(() => snapshots.at(-1)?.current?.presentationId === `broadcast:${valid.payload.id}`)
    const presentation = snapshots.at(-1)?.current
    assert.equal(presentation?.kind, 'message')
    assert.equal(presentation && 'actionLabel' in presentation ? presentation.actionLabel : null, 'Learn more')
    assert.doesNotMatch(JSON.stringify(presentation), /https:\/\//)
    service.stop()
  })
})

test('Relay actions remain narrow: messages open verified HTTPS and updates prefer the trusted updater', async () => {
  await withRelayStore(async (_path, stateStore) => {
    const scheduler = new FakeScheduler()
    const keys = relayFixtureKeys()
    const message = keys.signPayload(relayBroadcastFixture({ media: null }))
    const opened: string[] = []
    let updaterReady = false
    let response = { ...emptyResponse(), messages: [message] as typeof message[], update: null as null | RelaySignedEnvelope<ReturnType<typeof relayReleaseFixture>> }
    const service = new VastRelayService({
      config: { enabled: true, environment: 'staging', endpoint: 'https://relay-staging.vastbrowser.com', keys: [keys.trust] },
      stateStore,
      fetcher: async () => jsonResponse(response),
      currentVersion: () => '0.1.4',
      instanceKind: 'test',
      emitSnapshot: () => undefined,
      openExternal: async (url) => { opened.push(url) },
      applyTrustedUpdate: async () => updaterReady,
      now: () => RELAY_FIXTURE_NOW,
      random: () => 0.5,
      scheduler
    })
    await service.start()
    scheduler.runNext()
    await waitFor(() => service.snapshot().current?.kind === 'message')
    assert.deepEqual(await service.performAction(`broadcast:${message.payload.id}`), { ok: true, outcome: 'external' })
    assert.deepEqual(opened, ['https://vastbrowser.com/summer'])

    updaterReady = true
    response = { ...emptyResponse(), messages: [], update: keys.signPayload(relayReleaseFixture({ severity: 'critical' })) }
    scheduler.runNext()
    await waitFor(() => service.snapshot().current?.kind === 'update')
    assert.deepEqual(await service.performAction('release:0.2.0'), { ok: true, outcome: 'trusted-updater' })
    assert.equal(opened.length, 1)
    service.stop()
  })
})
