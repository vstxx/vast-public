import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))

test('simultaneous downloads preserve the newest queued renderer settings and main-owned history', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vast-download-storage-test-'))
  let release!: () => void
  let entered!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  let holdNextRename = false
  const modules = new Map<string, any>()
  function load(file: string): any {
    file = resolve(file)
    if (modules.has(file)) return modules.get(file)
    const exports: any = {}; modules.set(file, exports)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
    runInNewContext(code, {
      exports, process, console, Buffer, setTimeout, clearTimeout, URL, structuredClone,
      require: (id: string) => {
        if (id === 'node:fs/promises') return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
          if (holdNextRename) { holdNextRename = false; entered(); await new Promise<void>(resolve => { release = resolve }) }
          return fs.rename(...args)
        } }
        if (id === './data-path') return { vastDataPath: () => directory, dataFilePath: (name: string) => join(directory, name) }
        if (id === './performance-probe') return { recordStorageWrite() {} }
        if (id.startsWith('.')) return load(resolve(dirname(file), id.endsWith('.ts') ? id : id + '.ts'))
        return require(id)
      }
    })
    return exports
  }
  try {
    const storage = load(join(root, 'src/main/storage.ts'))
    const data = await storage.loadData()
    holdNextRename = true
    const first = storage.saveRendererData({...data, settings: {...data.settings, appearance: {...data.settings.appearance, cornerRadius: 21}}})
    await reached
    const newest = storage.saveRendererData({...data, settings: {...data.settings, appearance: {...data.settings.appearance, cornerRadius: 36}}})
    await new Promise(resolve => setImmediate(resolve))
    const item = (id: string) => ({id, filename:id+'.bin',url:'https://example.test/file',receivedBytes:100,totalBytes:100,state:'completed',startedAt:Date.now(),updatedAt:Date.now(),sourcePartition:'persist:isolated'})
    const downloads = [storage.upsertDownload(item('one')),storage.upsertDownload(item('two'))]
    await new Promise(resolve => setImmediate(resolve))
    release()
    await Promise.all([first,newest,...downloads])
    let stored = JSON.parse(await fs.readFile(join(directory,'vast-data.json'),'utf8'))
    assert.equal(stored.settings.appearance.cornerRadius,36)
    assert.deepEqual(stored.downloads.map((v: any)=>v.id).sort(),['one','two'])
    // Renderer reload/autosave can still contain an old list or private live data.
    await storage.saveRendererData({...stored,downloads:[item('private-never-durable')]})
    stored = JSON.parse(await fs.readFile(join(directory,'vast-data.json'),'utf8'))
    assert.deepEqual(stored.downloads.map((v: any)=>v.id).sort(),['one','two'])
  } finally {
    release?.()
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('vast-download-storage-test-'))
    await fs.rm(directory,{recursive:true,force:true})
  }
})
