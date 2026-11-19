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

// Loads the real storage module against a temporary data directory.
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vast-onboarding-history-test-'))
  const modules = new Map<string, any>()
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
    cleanup: async () => {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('vast-onboarding-history-test-'))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}

function profile(overrides: Record<string, unknown>): any {
  const constants = readFileSync(join(root, 'src/shared/constants.ts'), 'utf8')
  assert.match(constants, /onboarding: \{ completed: false, revision: 1 \}/)
  return { schemaVersion: 9, workspaces: [], tabs: [], history: [], bookmarks: [], notes: [], settings: {}, ...overrides }
}

const visits = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `h${index}`, title: `Page ${index}`, url: `https://example.com/${index}`, visitCount: 1, lastVisitedAt: 1_700_000_000_000 + index
}))

test('profiles without an onboarding record are onboarded, never pushed into setup', async () => {
  const item = await fixture()
  try {
    const legacy = item.storage.migrateData(profile({ schemaVersion: 5, onboarding: undefined }))
    assert.deepEqual(JSON.parse(JSON.stringify(legacy.onboarding)), { completed: true, revision: 1 })
  } finally { await item.cleanup() }
})

test('profiles stuck in onboarding by older builds are repaired once when clearly in use', async () => {
  const item = await fixture()
  try {
    const used = item.storage.migrateData(profile({ onboarding: { completed: false }, history: visits(25) }))
    assert.equal(used.onboarding.completed, true)
    const bookmarked = item.storage.migrateData(profile({ onboarding: { completed: false }, bookmarks: [{ id: 'b', title: 'B', url: 'https://b.test/', createdAt: 1, updatedAt: 1 }] }))
    assert.equal(bookmarked.onboarding.completed, true)
    // A genuinely new profile from an older build still sees onboarding.
    const fresh = item.storage.migrateData(profile({ onboarding: { completed: false }, history: visits(3) }))
    assert.deepEqual(JSON.parse(JSON.stringify(fresh.onboarding)), { completed: false, revision: 1 })
    // Records written by this build are never second-guessed, e.g. mid-setup after an import.
    const current = item.storage.migrateData(profile({ onboarding: { completed: false, revision: 1 }, history: visits(500) }))
    assert.equal(current.onboarding.completed, false)
    const done = item.storage.migrateData(profile({ onboarding: { completed: true, revision: 1 } }))
    assert.equal(done.onboarding.completed, true)
  } finally { await item.cleanup() }
})

test('clearing all history scrubs it from storage backups and leaves unreadable files alone', async () => {
  const item = await fixture()
  try {
    const backups = join(item.directory, 'storage-backups')
    await fs.mkdir(backups, { recursive: true })
    const withHistory = { schemaVersion: 9, history: visits(3), bookmarks: [{ id: 'keep' }], settings: { theme: 'dark' } }
    await fs.writeFile(join(backups, 'rolling-17000000000001.json'), JSON.stringify(withHistory))
    await fs.writeFile(join(backups, 'manual-17000000000002.json'), JSON.stringify({ ...withHistory, history: [] }))
    await fs.writeFile(join(backups, 'invalid-17000000000003.json'), '{ not json')
    await fs.writeFile(join(backups, 'unrelated.json'), JSON.stringify(withHistory))
    const result = await item.storage.scrubHistoryFromStorageBackups()
    assert.deepEqual({ ...result }, { scrubbed: 1, skipped: 1 })
    const scrubbed = JSON.parse(await fs.readFile(join(backups, 'rolling-17000000000001.json'), 'utf8'))
    assert.deepEqual(scrubbed.history, [])
    assert.deepEqual(scrubbed.bookmarks, [{ id: 'keep' }], 'everything except history is preserved')
    assert.equal(scrubbed.settings.theme, 'dark')
    assert.equal(await fs.readFile(join(backups, 'invalid-17000000000003.json'), 'utf8'), '{ not json')
    assert.equal(JSON.parse(await fs.readFile(join(backups, 'unrelated.json'), 'utf8')).history.length, 3, 'only Vast backup files are touched')
    assert.deepEqual((await fs.readdir(backups)).filter((name) => name.endsWith('.tmp')), [])
  } finally { await item.cleanup() }
})

test('motion settings: older profiles get Standard, Off stays Off, unknown levels are refused', async () => {
  const item = await fixture()
  try {
    const legacy = item.storage.migrateData(profile({ settings: { animations: true } }))
    assert.equal(legacy.settings.animations, true)
    assert.equal(legacy.settings.motionLevel, 'standard')
    const off = item.storage.migrateData(profile({ settings: { animations: false } }))
    assert.equal(off.settings.animations, false, 'turning animations off is never undone by the new setting')
    assert.equal(off.settings.motionLevel, 'standard')
    const enhanced = item.storage.migrateData(profile({ settings: { animations: true, motionLevel: 'enhanced' } }))
    assert.equal(enhanced.settings.motionLevel, 'enhanced')
    for (const motionLevel of ['off', 'ultra', 3, null]) {
      assert.equal(item.storage.migrateData(profile({ settings: { motionLevel } })).settings.motionLevel, 'standard', String(motionLevel))
    }
  } finally { await item.cleanup() }
})
