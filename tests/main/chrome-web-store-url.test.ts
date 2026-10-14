import assert from 'node:assert/strict'
import test from 'node:test'
import { parseChromeWebStoreListingUrl } from '../../src/shared/chrome-web-store.ts'

const ID = 'nckhacbgboonmhekihinhokldoogagoh'

test('parses a modern Chrome Web Store listing with a name and query parameters', () => {
  assert.deepEqual(
    parseChromeWebStoreListingUrl(`https://chromewebstore.google.com/detail/idu+/${ID}?hl=pl#details`),
    {
      extensionId: ID,
      sourceUrl: `https://chromewebstore.google.com/detail/idu+/${ID}`,
      store: 'chrome-web-store'
    }
  )
})

test('parses modern ID-only and legacy Web Store listings', () => {
  assert.equal(parseChromeWebStoreListingUrl(`https://chromewebstore.google.com/detail/${ID}`)?.extensionId, ID)
  assert.equal(parseChromeWebStoreListingUrl(`https://chrome.google.com/webstore/detail/extension/${ID}`)?.extensionId, ID)
  assert.equal(parseChromeWebStoreListingUrl(`https://chrome.google.com/webstore/detail/${ID}`)?.extensionId, ID)
})

test('does not confuse store homepages, regular Google pages, and other hosts with listings', () => {
  for (const value of [
    'https://chromewebstore.google.com/',
    'https://chrome.google.com/webstore/',
    'https://chrome.google.com/',
    `https://chromewebstore.google.com.evil.test/detail/example/${ID}`,
    `https://evil.test/detail/example/${ID}`,
    `https://chromewebstore.google.com/detail/example/${ID}/extra`
  ]) assert.equal(parseChromeWebStoreListingUrl(value), undefined, value)
})

test('rejects credentials, insecure URLs, malformed identities and encoded ID tricks', () => {
  for (const value of [
    `http://chromewebstore.google.com/detail/example/${ID}`,
    `https://user@chromewebstore.google.com/detail/example/${ID}`,
    `https://chromewebstore.google.com@evil.test/detail/example/${ID}`,
    `https://chromewebstore.google.com/detail/example/${ID.toUpperCase()}`,
    `https://chromewebstore.google.com/detail/example/${ID}%2fextra`,
    `https://chromewebstore.google.com/detail/example/${ID.slice(0, -1)}q`,
    'not a URL',
    ''
  ]) assert.equal(parseChromeWebStoreListingUrl(value), undefined, value)
})

test('does not mutate source navigation or authorize downloads', () => {
  const original = `https://chromewebstore.google.com/detail/idu+/${ID}?utm_source=example`
  const parsed = parseChromeWebStoreListingUrl(original)
  assert.equal(parsed?.extensionId, ID)
  assert.equal(parsed?.sourceUrl.includes('utm_source'), false)
  assert.equal(Object.keys(parsed ?? {}).sort().join(','), 'extensionId,sourceUrl,store')
})
