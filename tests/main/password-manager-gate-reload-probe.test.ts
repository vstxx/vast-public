import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { mainPageTarget, probeExtensionReload, reloadExpression } =
  require('../../scripts/password-manager-gate/probe-extension-reload.cjs')
const ID = 'nngceckbapebfimnlniiiahkandclblb'

test('reload probe selects one local Vast page and rejects non-canonical IDs', () => {
  assert.deepEqual(mainPageTarget([{ type: 'page', url: 'file:///vast/index.html', webSocketDebuggerUrl: 'ws://page' }]).type, 'page')
  assert.throws(() => mainPageTarget([{ type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://page' }]), /exactly one/i)
  assert.throws(() => reloadExpression('evil\'payload'), /canonical extension ID/i)
  assert.equal(reloadExpression(ID).includes('password'), false)
})

test('reload probe checks manager result, official identity, new worker, and privacy without vault data', async () => {
  let workerId = 'worker-old'
  const page = { type: 'page', url: 'file:///vast/index.html', webSocketDebuggerUrl: 'ws://page' }
  const result = await probeExtensionReload({ debuggerPort: 9223, extensionId: ID,
    fetchImpl: async () => ({ ok: true, json: async () => [page,
      { id: workerId, type: 'service_worker', url: `chrome-extension://${ID}/background.js` }] }),
    connect: async () => ({ async evaluate(expression: string) {
      assert.match(expression, /window\.vast\?\.extensions/)
      workerId = 'worker-new'
      return { apiOk: true, identityPreserved: true, enabled: true }
    }, close() {} }),
    capturePrivacy: async () => ({ extensionId: ID, optionalPrivacyGranted: true, keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ] }),
    wait: async () => undefined })
  assert.deepEqual(result, { apiOk: true, identityPreserved: true, enabled: true,
    workerRecreated: true, privacyRecovered: true, outcome: 'reload-and-worker-recovered' })
  assert.equal(JSON.stringify(result).includes('passwordSavingEnabled'), false)
})
