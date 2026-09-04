import { strict as assert } from 'node:assert'
import test from 'node:test'

import { tabOpenNavigationMetadata } from '../../src/main/windows/tab-open-metadata.ts'

test('window-open referrer is preserved with its policy', () => {
  const metadata = tabOpenNavigationMetadata({
    referrer: { url: 'https://www.planetminecraft.com/project/modern-apartment/', policy: 'strict-origin-when-cross-origin' }
  })
  assert.deepEqual(metadata, {
    referrer: { url: 'https://www.planetminecraft.com/project/modern-apartment/', policy: 'strict-origin-when-cross-origin' }
  })
})

test('form POST bodies survive the window-open to Vast-tab handoff', () => {
  const metadata = tabOpenNavigationMetadata({
    referrer: { url: 'http://127.0.0.1:9000/source', policy: 'strict-origin-when-cross-origin' },
    postBody: {
      contentType: 'application/x-www-form-urlencoded',
      data: [{ type: 'rawData', bytes: new Uint8Array([116, 111, 107, 101, 110]) }]
    }
  })
  assert.equal(metadata?.postBody?.contentType, 'application/x-www-form-urlencoded')
  assert.deepEqual(metadata?.postBody?.data, [{ type: 'rawData', bytes: new Uint8Array([116, 111, 107, 101, 110]) }])
  assert.equal(metadata?.referrer?.url, 'http://127.0.0.1:9000/source')
})

test('multipart POST bodies keep their boundary and file entries', () => {
  const metadata = tabOpenNavigationMetadata({
    referrer: null,
    postBody: {
      contentType: 'multipart/form-data',
      boundary: '----vastboundary',
      data: [
        { type: 'rawData', bytes: new Uint8Array([1, 2, 3]) },
        { type: 'file', filePath: 'C:\\temp\\upload.bin', offset: 0, length: 512 }
      ]
    }
  })
  assert.equal(metadata?.postBody?.boundary, '----vastboundary')
  assert.equal(metadata?.postBody?.data.length, 2)
  assert.deepEqual(metadata?.postBody?.data[1], { type: 'file', filePath: 'C:\\temp\\upload.bin', offset: 0, length: 512 })
})

test('non-http referrers and unknown post entries are dropped safely', () => {
  assert.equal(
    tabOpenNavigationMetadata({ referrer: { url: 'chrome://settings', policy: 'unsafe-url' } }),
    undefined
  )
  const junk = tabOpenNavigationMetadata({
    referrer: { url: 'https://ok.example/source', policy: 'strict-origin' },
    postBody: {
      contentType: 'application/x-www-form-urlencoded',
      data: [{ type: 'blob', uuid: 'not-supported' } as never]
    }
  })
  assert.ok(junk?.referrer)
  assert.equal(junk?.postBody, undefined)
})

test('a plain GET window-open carries no navigation metadata', () => {
  assert.equal(tabOpenNavigationMetadata({ referrer: null, postBody: null }), undefined)
  assert.equal(tabOpenNavigationMetadata({}), undefined)
})
