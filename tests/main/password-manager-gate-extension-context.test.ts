import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { evaluateExtensionExpression, extensionContextId } = require('../../scripts/password-manager-gate/extension-context.cjs')

function sessionFixture() {
  let listener: ((params: unknown) => void) | undefined
  return {
    on(_method: string, value: (params: unknown) => void) { listener = value; return () => { listener = undefined } },
    async send(method: string, params: { contextId?: number } = {}) {
      if (method === 'Runtime.enable') {
        listener?.({ context: { id: 1 } })
        listener?.({ context: { id: 2 } })
        return {}
      }
      if (method === 'Runtime.disable') return {}
      if (method === 'Runtime.evaluate' && params.contextId === 1) return { result: { value: false } }
      if (method === 'Runtime.evaluate' && params.contextId === 2) return { result: { value: true } }
      return { result: { value: false } }
    }
  }
}

test('extension context selection chooses only a context exposing chrome.runtime', async () => {
  assert.equal(await extensionContextId(sessionFixture(), async () => undefined), 2)
})

test('extension expression evaluation does not fall back to an unverified default context', async () => {
  const session = sessionFixture()
  const value = await evaluateExtensionExpression(session, 'safe-expression', async () => undefined)
  assert.equal(value, true)
  const missing = sessionFixture()
  missing.send = async () => ({ result: { value: false } })
  await assert.rejects(() => evaluateExtensionExpression(missing, 'safe-expression', async () => undefined),
    /execution context is unavailable/i)
})
