import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionHubClient } from '../../src/main/extensions/extension-hub-client.ts'

test('Hub client identifies the exact Vast version on catalog and details requests', async (t) => {
  const originalFetch = globalThis.fetch
  const seen: Array<{ url: string; version: string | null }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    seen.push({ url, version: new Headers(init?.headers).get('x-vast-version') })
    if (url.endsWith('/v1/catalog?page=1')) return Response.json({ items: [], featured: [], categories: [], page: 1, pageSize: 24, total: 0 })
    return Response.json({
      id: 'abcdefghijklmnopabcdefghijklmnop', slug: 'fixture', name: 'Fixture', summary: 'Fixture summary.', description: 'Fixture description.',
      publisher: { id: 'publisher_0123456789abcdef', name: 'Fixture Publisher', verified: false }, category: 'developer', kind: 'chrome', version: '1.0.0',
      updatedAt: '2026-09-25T00:00:00.000Z', downloads: 0, distribution: 'hub', installed: false, screenshots: [], permissions: { chrome: [], hosts: [], vast: [] }
    })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const client = new ExtensionHubClient('https://extensions.vastbrowser.com', [], '0.4.0')
  await client.catalog({})
  await client.details('abcdefghijklmnopabcdefghijklmnop')
  assert.deepEqual(seen.map((request) => request.version), ['0.4.0', '0.4.0'])
})
