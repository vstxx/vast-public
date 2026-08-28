import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = async (file: string): Promise<string> => readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8')

test('native extension code runs only in a dedicated sandboxed renderer with a narrow preload', async () => {
  const [runtime, preload, config] = await Promise.all([source('main/extensions/extension-native-runtime.ts'), source('preload/extension-host.ts'), readFile(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8')])
  assert.match(runtime, /nodeIntegration: false/)
  assert.match(runtime, /contextIsolation: true/)
  assert.match(runtime, /sandbox: true/)
  assert.match(runtime, /webSecurity: true/)
  assert.match(runtime, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  assert.match(runtime, /setPermissionRequestHandler/)
  assert.match(runtime, /url\.protocol !== 'vast-extension:'/)
  assert.doesNotMatch(runtime, /\beval\s*\(|new Function|vm\.run|require\(extension|child_process|worker_threads/)
  assert.match(config, /'extension-host': resolve\(__dirname, 'src\/preload\/extension-host\.ts'\)/)
  assert.match(preload, /contextBridge\.exposeInMainWorld\('vast', api\)/)
  assert.doesNotMatch(preload, /exposeInMainWorld\([^]*ipcRenderer|node:fs|child_process|VastApi/)
})

test('capability authority is derived from webContents and never from an extension-supplied ID', async () => {
  const [runtime, broker] = await Promise.all([source('main/extensions/extension-native-runtime.ts'), source('main/extensions/extension-capability-broker.ts')])
  assert.match(runtime, /this\.senders\.get\(sender\.id\)/)
  assert.match(runtime, /host\.window\.webContents\.id === sender\.id/)
  assert.match(broker, /authorityFor\(sender\)/)
  assert.match(broker, /Permission denied:/)
  assert.doesNotMatch(broker, /args\[[0-9]+\]\.extensionId|userProvidedExtensionId/)
})

test('resource protocol and storage enforce containment, CSP, JSON limits, and quotas', async () => {
  const [protocol, manifest, storage] = await Promise.all([source('main/extensions/extension-resource-protocol.ts'), source('main/extensions/extension-manifest.ts'), source('main/extensions/extension-storage.ts')])
  assert.match(protocol, /connect-src 'none'/)
  assert.match(protocol, /object-src 'none'/)
  assert.match(protocol, /decodeURIComponent/)
  assert.match(manifest, /realpath\(candidate\)/)
  assert.match(manifest, /isInside\(canonicalRoot, canonicalCandidate\)/)
  assert.match(storage, /5 \* 1024 \* 1024/)
  assert.match(storage, /atomicWriteJson/)
  assert.match(storage, /value !== '__proto__'/)
})
