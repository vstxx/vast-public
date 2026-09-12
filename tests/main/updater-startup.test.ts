import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../../src/main/updater-startup.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function fixture(mode: 'ready' | 'error' | 'exit' | 'timeout', pending = true) {
  let killed = false, unreferenced = false, spawned = false
  const output = Object.assign(new EventEmitter(), { destroy() {} })
  const child = Object.assign(new EventEmitter(), { stdout: output, kill() { killed = true }, unref() { unreferenced = true } })
  const exports: any = {}
  runInNewContext(compiled, {
    exports, Buffer, console: { warn() {} },
    setTimeout: (callback: () => void) => setTimeout(callback, 20), clearTimeout,
    process: { platform: 'win32', resourcesPath: 'C:\\Vast\\resources', env: { LOCALAPPDATA: 'C:\\cache' }, argv: ['C:\\Vast\\Vast.exe', '--profile=with spaces'], pid: 123 },
    require(name: string) {
      if (name === 'electron/main') return { app: { isPackaged: true, getPath: (key: string) => key === 'exe' ? 'C:\\Vast\\Vast.exe' : 'C:\\profile', getVersion: () => '0.2.7' } }
      if (name === './build-info') return { getBuildMetadata: () => ({}) }
      if (name === '../shared/updater-policy') return { updaterDisabledReason: () => undefined }
      if (name === './updater-pending') return { pendingUpdatePath: () => 'C:\\profile\\UpdateCache\\pending.json', pendingStartupDecision: async () => pending ? {} : undefined }
      if (name === 'node:fs') return { existsSync: () => pending }
      if (name === 'node:fs/promises') return { copyFile: async () => {}, writeFile: async () => {} }
      if (name === 'node:child_process') return { spawn: (_file: string, args: string[], options: any) => {
        spawned = true
        assert.ok(args.includes('-Handshake'))
        assert.equal(options.windowsHide, true)
        queueMicrotask(() => {
          child.emit('spawn') // Process existence alone must never approve a handoff.
          if (mode === 'ready') { output.emit('data', Buffer.from('VAST_UPDATE_')); output.emit('data', Buffer.from('READY\r\n')) }
          if (mode === 'error') child.emit('error', new Error('Execution blocked'))
          if (mode === 'exit') child.emit('exit', 1)
        })
        return child
      } }
      return require(name)
    }
  })
  return { run: () => exports.applyPendingUpdateAtStartup(), state: () => ({ killed, unreferenced, spawned }) }
}

test('startup exits only after its helper explicitly accepts the handoff', async () => {
  const valid = fixture('ready')
  assert.equal(await valid.run(), true)
  assert.deepEqual(valid.state(), { killed: false, unreferenced: true, spawned: true })
  for (const mode of ['error', 'exit', 'timeout'] as const) {
    const blocked = fixture(mode)
    assert.equal(await blocked.run(), false, mode + ' must leave the old browser running')
    assert.deepEqual(blocked.state(), { killed: true, unreferenced: false, spawned: true })
  }
})

test('ordinary startup does not spawn a helper without a pending update', async () => {
  const empty = fixture('ready', false)
  assert.equal(await empty.run(), false)
  assert.equal(empty.state().spawned, false)
})
