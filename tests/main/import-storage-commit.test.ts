import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vast-import-commit-test-'))
  const modules = new Map<string, any>()
  let failRenameCount = 0
  let failReadback = false
  let holdNextRename = false
  let releaseRename: (() => void) | undefined
  let renameEntered: (() => void) | undefined
  let renameEnteredPromise: Promise<void> = Promise.resolve()
  function load(file: string): any {
    file = resolve(file)
    if (modules.has(file)) return modules.get(file)
    const exports: any = {}; modules.set(file, exports)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    runInNewContext(code, {
      exports, process, console, Buffer, setTimeout, clearTimeout, URL, structuredClone,
      require: (id: string) => {
        if (id === 'node:fs/promises') return {
          ...fs,
          rename: async (...args: Parameters<typeof fs.rename>) => {
            if (failRenameCount > 0) { failRenameCount--; throw new Error('simulated rename failure') }
            if (holdNextRename) {
              holdNextRename = false
              await new Promise<void>((resolve) => { releaseRename = resolve; renameEntered?.() })
            }
            return fs.rename(...args)
          },
          readFile: async (...args: Parameters<typeof fs.readFile>) => {
            const result = await fs.readFile(...args)
            if (failReadback && String(args[0]).endsWith('vast-data.json')) {
              failReadback = false
              throw new Error('simulated readback failure')
            }
            return result
          }
        }
        if (id === './data-path') return { vastDataPath: () => directory, dataFilePath: (name: string) => join(directory, name) }
        if (id === './performance-probe') return { recordStorageWrite() {} }
        if (id.startsWith('.')) return load(resolve(dirname(file), id.endsWith('.ts') ? id : id + '.ts'))
        return require(id)
      }
    })
    return exports
  }
  return {
    directory,
    storage: load(join(root, 'src/main/storage.ts')),
    reloadStorage: () => { modules.clear(); return load(join(root, 'src/main/storage.ts')) },
    setFailRename: () => { failRenameCount = 5 },
    setFailReadback: () => { failReadback = true },
    holdRename: () => {
      renameEnteredPromise = new Promise<void>((resolve) => { renameEntered = resolve })
      holdNextRename = true
      return { entered: renameEnteredPromise, release: () => releaseRename?.() }
    },
    cleanup: async () => {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('vast-import-commit-test-'))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}

function candidate(current: any, operationId: string) {
  return {
    data: { ...current, bookmarks: [
      ...current.bookmarks,
      { id: `import-${operationId}`, title: 'Test', url: 'https://example.test/', createdAt: 1, updatedAt: 1 }
    ] },
    receipt: {
      operationId, sourceId: 'chrome', profileId: 'profile-a', committedAt: 1,
      counts: {
        bookmarks: { added: 1, updated: 0, skipped: 0, failed: 0, evicted: 0 },
        history: { added: 0, updated: 0, skipped: 0, failed: 0, evicted: 0 }
      }
    }
  }
}

test('independent extension receipts are durable and a failed item remains retryable', async () => {
  const item = await fixture()
  const id = 'a'.repeat(32)
  try {
    await item.storage.loadData()
    await item.storage.commitImportData('extension-operation', (current: any) => {
      const merged = candidate(current, 'extension-operation')
      return { ...merged, data: { ...merged.data, importState: { generation: current.importState?.generation ?? 0,
        phase: 'extensions-pending', pendingExtensionIds: [id] } } }
    })
    const failed = { id, status: 'failed', recordedAt: Date.now(), message: 'Controlled failure' }
    await item.storage.recordImportExtensionResult('extension-operation', failed)
    assert.deepEqual(Array.from((await item.storage.loadData()).importState.pendingExtensionIds), [id])
    const installed = { id, status: 'installed', recordedAt: Date.now() + 1 }
    await item.storage.recordImportExtensionResult('extension-operation', installed)
    const restarted = item.reloadStorage()
    const state = (await restarted.loadData()).importState
    assert.equal(state.pendingExtensionIds.length, 0)
    assert.equal(state.phase, 'completed')
    assert.equal(state.extensionReceipts[0].status, 'installed')
    assert.equal((await restarted.recordImportExtensionResult('extension-operation', installed)).status, 'installed')
  } finally { await item.cleanup() }
})

test('commit writes once, verifies disk, fences stale renderer saves, and retries by receipt', async () => {
  const { directory, storage, cleanup } = await fixture()
  try {
    const before = await storage.loadData()
    const first = await storage.commitImportData('op-1', (current: any) => candidate(current, 'op-1'))
    assert.equal(first.generation, 1)
    const persisted = JSON.parse(await fs.readFile(join(directory, 'vast-data.json'), 'utf8'))
    assert.equal(persisted.bookmarks.length, 1)
    assert.equal(persisted.importState.receipt.operationId, 'op-1')
    await assert.rejects(storage.saveRendererData(before), /stale|generation/i)
    let mergedAgain = false
    const retry = await storage.commitImportData('op-1', () => { mergedAgain = true; throw new Error('should not merge') })
    assert.equal(mergedAgain, false)
    assert.equal(retry.receipt.operationId, 'op-1')
    assert.equal((await storage.loadData()).bookmarks.length, 1)
  } finally { await cleanup() }
})

test('failed write stays retryable without duplicate imported data', async () => {
  const { storage, setFailRename, cleanup } = await fixture()
  try {
    await storage.loadData()
    setFailRename()
    await assert.rejects(storage.commitImportData('op-2', (current: any) => candidate(current, 'op-2')))
    const retry = await storage.commitImportData('op-2', (current: any) => candidate(current, 'op-2'))
    assert.equal(retry.data.bookmarks.length, 1)
    assert.equal(retry.generation, 1)
  } finally { await cleanup() }
})

test('readback failure after rename is reconciled by operation receipt after restart', async () => {
  const { storage, setFailReadback, reloadStorage, cleanup } = await fixture()
  try {
    await storage.loadData()
    setFailReadback()
    await assert.rejects(storage.commitImportData('op-3', (current: any) => candidate(current, 'op-3')))
    const restarted = reloadStorage()
    const retry = await restarted.commitImportData('op-3', () => { throw new Error('must not duplicate') })
    assert.equal(retry.data.bookmarks.length, 1)
    assert.equal(retry.generation, 1)
  } finally { await cleanup() }
})

test('renderer cannot forge a future import generation', async () => {
  const { storage, cleanup } = await fixture()
  try {
    const before = await storage.loadData()
    await assert.rejects(storage.saveRendererData({
      ...before, importState: { generation: 999, phase: 'completed' }
    }), /generation/i)
    await storage.commitImportData('op-forge', (current: any) => candidate(current, 'op-forge'))
    const current = await storage.loadData()
    await assert.rejects(storage.saveRendererData({
      ...current, importState: { generation: 1, phase: 'completed' }
    }), /import state/i)
  } finally { await cleanup() }
})

test('queued pre-import renderer save cannot overwrite a committed import', async () => {
  const { storage, holdRename, cleanup } = await fixture()
  let unblock: (() => void) | undefined
  try {
    const before = await storage.loadData()
    const gate = holdRename()
    unblock = gate.release
    const firstSave = storage.saveRendererData({ ...before, settings: { ...before.settings, appearance: { ...before.settings.appearance, cornerRadius: 21 } } })
    await gate.entered
    const commit = storage.commitImportData('op-queued', (current: any) => candidate(current, 'op-queued'))
    const staleSave = storage.saveRendererData(before)
    gate.release()
    await firstSave
    await commit
    await assert.rejects(staleSave, /generation/i)
    assert.equal((await storage.loadData()).bookmarks.length, 1)
  } finally { unblock?.(); await cleanup() }
})

test('deliberate backup restore advances generation and cannot be overwritten by pre-restore autosave', async () => {
  const { storage, cleanup } = await fixture()
  try {
    const original = await storage.loadData()
    const backup = await storage.createStorageBackup('manual')
    assert.ok(backup)
    await storage.commitImportData('op-4', (current: any) => candidate(current, 'op-4'))
    const restored = await storage.restoreStorageBackup(backup.id)
    assert.equal(restored.bookmarks.length, 0)
    assert.equal(restored.importState.generation, 2)
    await assert.rejects(storage.saveRendererData(original), /stale|generation/i)
  } finally { await cleanup() }
})
