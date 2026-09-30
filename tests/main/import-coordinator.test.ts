import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DATA } from '../../src/shared/constants.ts'
import type { BrowserSourceSnapshot } from '../../src/shared/browser-import.ts'
import type { PersistedData } from '../../src/shared/types.ts'
import { ImportCoordinator } from '../../src/main/import/import-coordinator.ts'

function snapshot(): BrowserSourceSnapshot {
  return {
    sourceId: 'chrome', profileId: 'p',
    bookmarks: [{ title: 'Example', url: 'https://example.test/', sourceItemId: '1', root: 'bar', folderPath: [], folderSourceIds: [] }],
    history: [], extensions: [],
    categories: { bookmarks: { status: 'ready' }, history: { status: 'empty' }, extensions: { status: 'empty' } }
  }
}

function harness(readSnapshot: () => BrowserSourceSnapshot = snapshot) {
  let data: PersistedData = structuredClone(DEFAULT_DATA)
  let path = 'C:/controlled/Chrome/Default'
  let reads = 0
  let clock = 1_000
  let tokenCounter = 0
  const coordinator = new ImportCoordinator({
    resolveProfile: async (sourceId, profileId) => ({ sourceId, profileId, canonicalPath: path }),
    readSource: async () => { reads++; return readSnapshot() },
    loadData: async () => data,
    commitData: async (operationId, merge) => {
      if (data.importState?.receipt?.operationId === operationId) {
        return { data, receipt: data.importState.receipt, generation: data.importState.generation }
      }
      const result = merge(data)
      const generation = (data.importState?.generation ?? 0) + 1
      data = { ...result.data, importState: { generation, phase: 'extensions-pending', receipt: result.receipt,
        pendingExtensionIds: result.data.importState?.pendingExtensionIds ?? [] } }
      return { data, receipt: result.receipt, generation }
    },
    now: () => clock,
    token: () => `token-${++tokenCounter}`
  })
  return { coordinator, getData: () => data, getReads: () => reads, changePath: () => { path = 'C:/controlled/Chrome/Other' }, advance: (ms: number) => { clock += ms } }
}

const request = { sourceId: 'chrome' as const, profileId: 'p', types: ['bookmarks' as const] }

test('prepare and preview are read-only, commit is once-only and receipt survives status', async () => {
  const fixture = harness()
  const preview = await fixture.coordinator.prepare(request)
  assert.equal(fixture.getData().bookmarks.length, 0)
  assert.equal(preview.detected.bookmarks, 1)
  assert.equal(JSON.stringify(preview).includes('example.test'), false)
  assert.equal(JSON.stringify(preview).includes('C:/'), false)
  assert.equal((await fixture.coordinator.status()).preview, undefined, 'status never exposes the active capability token')
  assert.deepEqual(fixture.coordinator.preview(preview.token), preview)
  const receipt = await fixture.coordinator.commit({ token: preview.token, acceptPartial: false, selectedExtensionIds: [] })
  assert.equal(receipt.counts.bookmarks.added, 1)
  assert.equal(fixture.getData().bookmarks.length, 1)
  const retry = await fixture.coordinator.commit({ token: preview.token, acceptPartial: false, selectedExtensionIds: [] })
  assert.equal(retry.operationId, receipt.operationId)
  assert.equal(fixture.getData().bookmarks.length, 1)
  assert.equal((await fixture.coordinator.status()).receipt?.operationId, receipt.operationId)
  assert.equal(fixture.getReads(), 1)
  const next = await fixture.coordinator.prepare(request)
  assert.equal(next.detected.bookmarks, 1)
})

test('partial category failure requires explicit consent and reports independent counts', async () => {
  const fixture = harness(() => {
    const result = snapshot()
    result.categories.bookmarks = { status: 'failed', code: 'SOURCE_READ_FAILED' }
    result.bookmarks = []
    return result
  })
  const original = fixture.coordinator
  const preview = await original.prepare(request)
  await assert.rejects(original.commit({ token: preview.token, acceptPartial: false, selectedExtensionIds: [] }), /partial/i)
  const accepted = await original.commit({ token: preview.token, acceptPartial: true, selectedExtensionIds: [] })
  assert.equal(accepted.counts.bookmarks.failed, 1)
})

test('changed profile path, expiry, and discard invalidate prepared token', async () => {
  const changed = harness()
  const first = await changed.coordinator.prepare(request)
  changed.changePath()
  await assert.rejects(changed.coordinator.commit({ token: first.token, acceptPartial: false, selectedExtensionIds: [] }), /changed/i)
  assert.equal(changed.getData().bookmarks.length, 0)

  const expired = harness()
  const second = await expired.coordinator.prepare(request)
  expired.advance(11 * 60_000)
  await assert.rejects(expired.coordinator.commit({ token: second.token, acceptPartial: false, selectedExtensionIds: [] }), /expired/i)

  const discarded = harness()
  const third = await discarded.coordinator.prepare(request)
  await discarded.coordinator.discard(third.token)
  assert.equal((await discarded.coordinator.status()).preview, undefined)
  await assert.rejects(discarded.coordinator.commit({ token: third.token, acceptPartial: false, selectedExtensionIds: [] }), /token/i)
})

test('invalid and concurrent prepare requests cannot replace an active preview', async () => {
  const fixture = harness()
  await assert.rejects(fixture.coordinator.prepare({ ...request, profileId: '../escape' }), /invalid/i)
  const first = await fixture.coordinator.prepare(request)
  await assert.rejects(fixture.coordinator.prepare(request), /active|progress/i)
  assert.equal(fixture.coordinator.preview(first.token).token, first.token)
})

test('failed prepare is retryable and does not leave a hidden active import', async () => {
  let attempt = 0
  const fixture = harness(() => {
    if (++attempt === 1) throw new Error('controlled source read failure')
    return snapshot()
  })
  await assert.rejects(fixture.coordinator.prepare(request), /source read failure/)
  assert.equal(fixture.getData().bookmarks.length, 0)
  const retry = await fixture.coordinator.prepare(request)
  assert.equal(retry.detected.bookmarks, 1)
  assert.equal(fixture.getReads(), 2)
})

test('two simultaneous commits cannot both mutate the candidate', async () => {
  const fixture = harness()
  const preview = await fixture.coordinator.prepare(request)
  const first = fixture.coordinator.commit({ token: preview.token, acceptPartial: false, selectedExtensionIds: [] })
  const second = fixture.coordinator.commit({ token: preview.token, acceptPartial: false, selectedExtensionIds: [] })
  const settled = await Promise.allSettled([first, second])
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(settled.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(fixture.getData().bookmarks.length, 1)
})

test('selected source extension IDs are persisted only with the verified data commit', async () => {
  const id = 'a'.repeat(32)
  const fixture = harness(() => ({ ...snapshot(), extensions: [{ id, name: 'Controlled', version: '1.0.0',
    sourceEnabled: true, manifestVersion: 3, state: 'detected', limitationCodes: [], fingerprint: 'b'.repeat(64) }],
  categories: { bookmarks: { status: 'ready' }, history: { status: 'empty' }, extensions: { status: 'ready' } } }))
  const preview = await fixture.coordinator.prepare({ ...request, types: ['bookmarks', 'extensions'] })
  assert.equal(preview.detectedExtensions[0].id, id)
  assert.deepEqual((await fixture.coordinator.status()).pendingExtensionIds, [])
  const receipt = await fixture.coordinator.commit({ token: preview.token, acceptPartial: false, selectedExtensionIds: [id] })
  assert.equal(receipt.counts.bookmarks.added, 1)
  assert.deepEqual((await fixture.coordinator.status()).pendingExtensionIds, [id])
})

test('extension transfer requires committed selection and permission consent; results stay independent of imported data', async () => {
  const id = 'a'.repeat(32)
  const second = 'b'.repeat(32)
  let data: PersistedData = { ...structuredClone(DEFAULT_DATA), bookmarks: [{ id: 'existing', title: 'Existing',
    url: 'https://existing.test/', createdAt: 1, updatedAt: 1 }] }
  let activated = 0
  let cancelled = 0
  const coordinator = new ImportCoordinator({
    resolveProfile: async (sourceId, profileId) => ({ sourceId, profileId, canonicalPath: 'C:/controlled/Chrome/Default' }),
    readSource: async () => ({ ...snapshot(), extensions: [id, second].map((extensionId) => ({ id: extensionId,
      name: 'Controlled', version: '1.0.0', sourceEnabled: true, manifestVersion: 3 as const,
      state: 'detected' as const, limitationCodes: [], fingerprint: 'f'.repeat(64) })) }),
    loadData: async () => data,
    commitData: async () => { throw new Error('not used') },
    extensionManager: {
      list: async () => [],
      prepareLocalChromiumImport: async (input) => ({ token: `token-${input.sourceExtensionId}`, extensionId: input.sourceExtensionId,
        name: 'Controlled', version: '1.0.0', publisherName: 'Local / Unverified', source: 'local-chromium',
        trust: 'local', kind: 'chrome', permissions: { chrome: ['storage'], hosts: [], vast: [] },
        isUpdate: false, permissionEscalation: { chrome: ['storage'], hosts: [], vast: [] } }),
      confirmLocalChromiumImport: async (_token, approval) => {
        assert.deepEqual(approval.chrome, ['storage'])
        activated++
        return { id, compatibility: 'compatible', source: 'local-chromium' } as any
      },
      cancelPrepared: async () => { cancelled++ }
    },
    recordExtensionResult: async (_operationId, result) => {
      data = { ...data, importState: { ...data.importState!, pendingExtensionIds:
        result.status === 'failed' ? data.importState!.pendingExtensionIds : data.importState!.pendingExtensionIds!.filter((item) => item !== result.id),
      extensionReceipts: [...(data.importState!.extensionReceipts ?? []), result] } }
      return result
    }
  })
  await assert.rejects(coordinator.prepareSelectedExtension('op', id), /not pending/i)
  data.importState = { generation: 1, phase: 'extensions-pending', pendingExtensionIds: [id, second],
    receipt: { operationId: 'op', sourceId: 'chrome', profileId: 'Default', committedAt: 1,
      counts: { bookmarks: { added: 0, updated: 0, skipped: 0, failed: 0, evicted: 0 },
        history: { added: 0, updated: 0, skipped: 0, failed: 0, evicted: 0 } } } }
  const prepared = await coordinator.prepareSelectedExtension('op', id)
  assert.equal(prepared.kind, 'preview')
  assert.equal(activated, 0)
  assert.equal(data.bookmarks.length, 1)
  if (prepared.kind !== 'preview') throw new Error('expected preview')
  const receipt = await coordinator.confirmSelectedExtension({ operationId: 'op', extensionId: id,
    token: prepared.preview.token, approval: prepared.preview.permissions })
  assert.equal(receipt.status, 'installed')
  assert.equal(activated, 1)
  assert.deepEqual((await coordinator.status()).pendingExtensionIds, [second])
  const other = await coordinator.prepareSelectedExtension('op', second)
  assert.equal(other.kind, 'preview')
  assert.equal((await coordinator.declineSelectedExtension('op', second)).status, 'declined')
  assert.equal(cancelled, 1)
  assert.deepEqual((await coordinator.status()).pendingExtensionIds, [])
  assert.equal(data.bookmarks.length, 1)
})

test('extension preparation reports a safe reason without leaking a source path', async () => {
  const id = 'a'.repeat(32)
  let failure = new Error('Extension contains a private or invalid path at C:/private/profile')
  const data: PersistedData = { ...structuredClone(DEFAULT_DATA), importState: {
    generation: 1, phase: 'extensions-pending', pendingExtensionIds: [id],
    receipt: { operationId: 'op', sourceId: 'chrome', profileId: 'Default', committedAt: 1,
      counts: { bookmarks: { added: 0, updated: 0, skipped: 0, failed: 0, evicted: 0 },
        history: { added: 0, updated: 0, skipped: 0, failed: 0, evicted: 0 } } }
  } }
  const coordinator = new ImportCoordinator({
    resolveProfile: async (sourceId, profileId) => ({ sourceId, profileId, canonicalPath: 'C:/private/profile' }),
    readSource: async () => ({ ...snapshot(), extensions: [{ id, name: 'Controlled', version: '1.0.0',
      sourceEnabled: true, manifestVersion: 3, state: 'detected', limitationCodes: [], fingerprint: 'f'.repeat(64) }] }),
    loadData: async () => data,
    commitData: async () => { throw new Error('not used') },
    extensionManager: {
      list: async () => [],
      prepareLocalChromiumImport: async () => { throw failure },
      confirmLocalChromiumImport: async () => { throw new Error('not used') },
      cancelPrepared: async () => undefined
    },
    recordExtensionResult: async (_operationId, result) => result
  })
  const result = await coordinator.prepareSelectedExtension('op', id)
  assert.equal(result.kind, 'result')
  if (result.kind !== 'result') throw new Error('expected result')
  assert.equal(result.receipt.status, 'failed')
  assert.equal(result.receipt.message, 'Unsafe extension file structure')
  assert.equal(JSON.stringify(result).includes('C:/private'), false)
  failure = new Error('Unexpected validation failure at C:/private/profile')
  const retry = await coordinator.prepareSelectedExtension('op', id)
  assert.equal(retry.kind, 'result')
  if (retry.kind !== 'result') throw new Error('expected result')
  assert.equal(retry.receipt.status, 'failed')
  assert.equal(retry.receipt.message, 'Extension could not be validated')
  assert.equal(JSON.stringify(retry).includes('C:/private'), false)
})
