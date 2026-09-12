import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FiltersEngine, Resources, Request } from '@ghostery/adblocker'
import { adblockHostname, normalizeAdblockHost } from '../../resources/first-party-extensions/adblocker-for-vast/src/hosts.ts'
import { defaults, validateSettings } from '../../resources/first-party-extensions/adblocker-for-vast/src/settings.ts'
import { validateList, download } from '../../resources/first-party-extensions/adblocker-for-vast/src/cache.ts'
import { parseSupported } from '../../resources/first-party-extensions/adblocker-for-vast/src/rules.ts'

test('standalone site identity normalizes IDNA, addresses and exact hosts', () => {
  assert.equal(adblockHostname('https://Sub.Example.com.:8443/a'), 'sub.example.com')
  assert.equal(normalizeAdblockHost('B\u00dcCHER.de'), 'xn--bcher-kva.de')
  assert.equal(adblockHostname('http://[::1]:8080/'), '[::1]')
  assert.equal(normalizeAdblockHost('localhost'), 'localhost')
  for (const url of ['file:///x', 'vast://settings', 'chrome-extension://abc/a', 'data:text/html,x', 'null', 'https://']) assert.equal(adblockHostname(url), undefined)
  for (const host of ['example.com/path', 'https://example.com', 'example.com:80', '*.example.com']) assert.equal(normalizeAdblockHost(host), undefined)
})

test('standalone settings preserve custom rules and reject malformed schemas', () => {
  const value = validateSettings({ ...defaults(), allowlist: ['EXAMPLE.com', 'example.com'], customFilters: '||ads.example^' })
  assert.deepEqual(value.allowlist, ['example.com'])
  assert.equal(validateSettings(JSON.parse(JSON.stringify(value))).customFilters, '||ads.example^')
  for (const changed of [{ schema: 2 }, { enabled: 'true' }, { lists: ['unknown'] }, { customFilters: 'x'.repeat(65537) }, { allowlist: ['evil.test/path'] }]) assert.throws(() => validateSettings({ ...defaults(), ...changed }))
  assert.equal(validateSettings({ ...defaults(), allowlist: ['example.com'] }).allowlist.includes('sub.example.com'), false)
})

test('download validation rejects HTML, truncation, excessive lines and preserves last good data', async t => {
  const text = '! Valid list\n' + '||ads.example^\n'.repeat(100)
  const previous = { text, updatedAt: 1, checkedAt: 1, etag: 'previous' }
  for (const invalid of ['<html>error</html>', '! x', '! valid\n' + 'x'.repeat(16385), '! valid\n' + '\0'.repeat(200)]) assert.throws(() => validateList(invalid))
  let init: RequestInit | undefined
  const stub = t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => { init = options; return new Response(null, { status: 304 }) })
  const unchanged = await download('https://easylist.to/easylist/easylist.txt', previous)
  assert.equal(unchanged.text, text)
  assert.equal(unchanged.updatedAt, 1)
  assert.equal(init?.redirect, 'error')
  assert.equal(init?.credentials, 'omit')
  assert.equal((init?.headers as Record<string, string>)['If-None-Match'], 'previous')
  stub.mock.mockImplementation(async () => new Response('<html>service unavailable</html>'))
  await assert.rejects(download('https://easylist.to/easylist/easylist.txt', previous))
  assert.equal(previous.text, text)
  stub.mock.mockImplementation(async () => new Response('! Valid list\n' + '||ads.example^\n'.repeat(8)))
  await assert.rejects(download('https://easylist.to/easylist/easylist.txt', previous), /small/)
})

test('engine rules preserve exceptions, third-party semantics and reject unsupported custom syntax', () => {
  const resources = Resources.parse('{"scriptlets":[],"redirects":[]}', { checksum: 'fixture' })
  const parsed = parseSupported('||ads.example^$third-party\n@@||ads.example/allowed.js$script\nexample.com##.advert', resources)
  assert.equal(parsed.unsupported, 0)
  const engine = new FiltersEngine(parsed)
  const restored = FiltersEngine.deserialize(engine.serialize())
  assert.equal(restored.match(Request.fromRawDetails({ url: 'https://ads.example/ad.js', sourceUrl: 'https://example.com', type: 'script' })).match, true)
  assert.equal(restored.match(Request.fromRawDetails({ url: 'https://ads.example/allowed.js', sourceUrl: 'https://example.com', type: 'script' })).match, false)
  assert.equal(restored.match(Request.fromRawDetails({ url: 'https://ads.example/ad.js', sourceUrl: 'https://ads.example', type: 'script' })).match, false)
  assert.ok(parseSupported('example.com##+js(set-constant, x, true)\nexample.com##div:has-text(ad)', resources).unsupported >= 2)
})

test('browser distribution excludes the product and engine; extension owns identity and runtime', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8'))
  const manifest = JSON.parse(await readFile('resources/first-party-extensions/adblocker-for-vast/manifest.json', 'utf8'))
  assert.equal(root.dependencies['@ghostery/adblocker'], undefined)
  assert.equal(root.build.extraResources.some((entry: { from: string }) => /adblock|first-party-extensions/.test(entry.from)), false)
  assert.equal(manifest.name, 'Adblocker for Vast')
  assert.equal(manifest.vast_network, 1)
  assert.ok(manifest.permissions.includes('webRequestBlocking'))
  assert.equal(manifest.permissions.includes('scripting'), false)
})
