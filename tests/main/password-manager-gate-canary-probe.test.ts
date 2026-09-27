import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { exposeUrlCanary, verifyCanaryArtifacts } = require('../../scripts/password-manager-gate/probe-secret-canary.cjs')
const CANARY = `VAST_GATE_CANARY_${'a'.repeat(48)}`

test('live canary probe confirms controlled query reached only the approved fixture target', async () => {
  let current = 'https://login.vast-test.local:4443/login'
  const navigation: string[] = []
  let closed = false
  const result = await exposeUrlCanary({ debuggerPort: 9223, fixturePort: 4443, canary: CANARY,
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'page-1', type: 'webview',
      url: current, webSocketDebuggerUrl: 'ws://page' }] }),
    connect: async () => ({ async send(method: string, params: { url: string }) {
      assert.equal(method, 'Page.navigate')
      navigation.push(params.url)
      current = params.url
      return {}
    }, close() { closed = true } }),
    wait: async () => undefined })
  assert.equal(result, true)
  assert.equal(navigation.length, 2)
  assert.equal(navigation[0].includes(CANARY), true)
  assert.equal(navigation[1].includes(CANARY), false)
  assert.equal(closed, true)
})

test('canary scanner fails without echoing a leaked marker', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-live-canary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runRoot = join(root, 'run')
  const backgroundRoot = join(root, 'background')
  mkdirSync(runRoot)
  mkdirSync(backgroundRoot)
  writeFileSync(join(runRoot, 'events.jsonl'), '{"url":"https://login.vast-test.local/login"}\n')
  writeFileSync(join(backgroundRoot, 'process.log'), 'safe')
  writeFileSync(join(backgroundRoot, 'process-error.log'), 'safe')
  assert.equal(verifyCanaryArtifacts({ runRoot, backgroundRoot, canary: CANARY }), true)
  writeFileSync(join(backgroundRoot, 'process-error.log'), encodeURIComponent(CANARY))
  assert.throws(() => verifyCanaryArtifacts({ runRoot, backgroundRoot, canary: CANARY }),
    (error: Error) => !error.message.includes(CANARY))
})
