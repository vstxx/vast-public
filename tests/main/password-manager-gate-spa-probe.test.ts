import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { probeSpaRoute } = require('../../scripts/password-manager-gate/probe-spa-route.cjs')
const ID = 'nngceckbapebfimnlniiiahkandclblb'

test('SPA probe requires same document, replaced form, changed route and fresh Bitwarden overlay', async () => {
  let step = 0
  let closed = false
  const sent: string[] = []
  const session = {
    async send(method: string) {
      sent.push(method)
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'same-frame' } } }
      return {}
    },
    async evaluate(expression: string) {
      if (expression === 'window.__vastGate.snapshot()') return step === 0
        ? { fixture: 'spa-login', route: '/spa', frameOrigin: 'https://spa.vast-test.local:4443',
          usernamePresent: false, passwordPresent: false, usernameMatchesExpectedHash: false,
          passwordMatchesExpectedHash: false, unexpectedForeignFill: false,
          submitted: false, submissionMatchedExpectedHashes: false }
        : { fixture: 'spa-login', route: '/spa/route-two', frameOrigin: 'https://spa.vast-test.local:4443',
          usernamePresent: false, passwordPresent: false, usernameMatchesExpectedHash: false,
          passwordMatchesExpectedHash: false, unexpectedForeignFill: false,
          submitted: false, submissionMatchedExpectedHashes: false }
      if (expression.includes('window.__vastGate.navigate')) {
        step = 1
        return { documentPreserved: true, formReplaced: true, routeChanged: true, x: 100, y: 100 }
      }
      if (expression.includes('__vastGateRouteProbe ===')) return true
      throw new Error('Unexpected fixture expression')
    },
    close() { closed = true }
  }
  const result = await probeSpaRoute({ debuggerPort: 9223, fixturePort: 4443, extensionId: ID,
    fetchImpl: async () => ({ ok: true, json: async () => [
      { id: 'page', type: 'webview', url: 'https://spa.vast-test.local:4443/spa', webSocketDebuggerUrl: 'ws://page' },
      { id: step ? 'new-overlay' : 'old-overlay', type: 'iframe',
        url: `chrome-extension://${ID}/overlay/menu-button.html` }
    ] }), connect: async () => session, wait: async () => undefined })
  assert.deepEqual(result, { documentPreserved: true, formReplaced: true, routeChanged: true, overlayCreated: true })
  assert.equal(sent.filter((method) => method === 'Input.dispatchMouseEvent').length, 3)
  assert.equal(closed, true)
})
