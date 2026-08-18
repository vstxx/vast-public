import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchPrivateNetworkText, MAX_NETWORK_REDIRECTS, safeHttpUrl } from '../../src/main/network/safe-http.ts'

test('network discovery URL allowlist excludes localhost, loopback, and public hosts', () => {
  assert.equal(safeHttpUrl('http://192.168.1.20/device.xml'), 'http://192.168.1.20/device.xml')
  assert.equal(safeHttpUrl('https://speaker.local/device.xml'), 'https://speaker.local/device.xml')
  assert.equal(safeHttpUrl('http://localhost/device.xml'), undefined)
  assert.equal(safeHttpUrl('http://127.0.0.1/device.xml'), undefined)
  assert.equal(safeHttpUrl('https://example.com/device.xml'), undefined)
  assert.equal(safeHttpUrl('http://user:secret@192.168.1.20/device.xml'), undefined)
})

test('network discovery follows only manual redirects that remain allowlisted', async () => {
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = []
  const result = await fetchPrivateNetworkText('http://192.168.1.20/start', 1_000, async (input, init) => {
    requests.push({ url: String(input), redirect: init?.redirect })
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: '/device.xml' } })
      : new Response('<root>device</root>')
  })
  assert.equal(result.text, '<root>device</root>')
  assert.deepEqual(requests, [
    { url: 'http://192.168.1.20/start', redirect: 'manual' },
    { url: 'http://192.168.1.20/device.xml', redirect: 'manual' }
  ])
})

test('network discovery rejects redirects to localhost, public hosts, and loops', async () => {
  for (const location of ['http://localhost/admin', 'https://example.com/device.xml']) {
    let requests = 0
    await assert.rejects(
      () => fetchPrivateNetworkText('http://192.168.1.20/start', 1_000, async () => {
        requests += 1
        return new Response(null, { status: 302, headers: { location } })
      }),
      /allowlist/i
    )
    assert.equal(requests, 1)
  }

  let loopRequests = 0
  await assert.rejects(
    () => fetchPrivateNetworkText('http://192.168.1.20/start', 1_000, async () => {
      loopRequests += 1
      return new Response(null, { status: 307, headers: { location: '/start' } })
    }),
    /redirect limit/i
  )
  assert.equal(loopRequests, MAX_NETWORK_REDIRECTS + 1)
})
