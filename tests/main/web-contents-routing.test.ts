import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chromeWebContentsFor,
  sendBrowserTabOpenRequest,
  type ChromeWebContentsLike
} from '../../src/main/windows/web-contents-routing.ts'

function contents(destroyed = false): ChromeWebContentsLike & { sent: Array<{ channel: string; value: unknown }> } {
  const sent: Array<{ channel: string; value: unknown }> = []
  return {
    sent,
    isDestroyed: () => destroyed,
    send: (channel, value) => sent.push({ channel, value })
  }
}

test('webview host renderer is preferred over owner-window fallback', () => {
  const host = contents()
  const fallback = contents()
  let fallbackCalls = 0
  const opener = { isDestroyed: () => false, hostWebContents: host }

  assert.equal(chromeWebContentsFor(opener, () => { fallbackCalls++; return fallback }), host)
  assert.equal(fallbackCalls, 0)

  const request = { url: 'https://example.com', sourceWebContentsId: 42, disposition: 'foreground-tab', activate: true }
  assert.equal(sendBrowserTabOpenRequest(opener, request, () => fallback), true)
  assert.deepEqual(host.sent, [{ channel: 'vast:browser:open-tab', value: request }])
  assert.equal(fallback.sent.length, 0)
})

test('destroyed hosts use the exact owner fallback and missing receivers fail closed', () => {
  const fallback = contents()
  const opener = { isDestroyed: () => false, hostWebContents: contents(true) }
  assert.equal(chromeWebContentsFor(opener, () => fallback), fallback)
  assert.equal(chromeWebContentsFor(opener, () => contents(true)), undefined)
  assert.equal(sendBrowserTabOpenRequest(opener, {}, () => undefined), false)
})
