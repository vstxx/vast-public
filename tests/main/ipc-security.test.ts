import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { isSafeDownloadUrl, isTrustedRendererUrl } from '../../src/main/ipc-security.ts'

test('exact dev renderer origin is trusted and random localhost is rejected', () => {
  assert.equal(
    isTrustedRendererUrl('http://localhost:5173/src/renderer/main.tsx', {
      isPackaged: false,
      rendererUrl: 'http://localhost:5173'
    }),
    true
  )
  assert.equal(
    isTrustedRendererUrl('http://localhost:5174/src/renderer/main.tsx', {
      isPackaged: false,
      rendererUrl: 'http://localhost:5173'
    }),
    false
  )
})

test('packaged renderer trust is limited to file app chrome', () => {
  const rendererPath = 'C:\\Program Files\\Vast\\resources\\app.asar\\out\\renderer\\index.html'
  const options = { isPackaged: true, packagedRendererPath: rendererPath }
  assert.equal(isTrustedRendererUrl('file:///C:/Program%20Files/Vast/resources/app.asar/out/renderer/index.html?detached=1#ready', options), true)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:3000', options), false)
  assert.equal(isTrustedRendererUrl('file:///C:/Temp/evil.html', options), false)
  assert.equal(isTrustedRendererUrl('file:///C:/Program%20Files/Vast/resources/app.asar/out/renderer/other.html', options), false)
  assert.equal(isTrustedRendererUrl('file:///C:/Program%20Files/Vast/resources/app.asar/out/renderer/../main/main.html', options), false)
  assert.equal(isTrustedRendererUrl('file:///C:/Program%20Files/Vast/resources/app.asar/out/renderer/%2e%2e/main/main.html', options), false)
})

test('built non-packaged smoke runs use the exact file boundary when Vite is absent', () => {
  const entry = resolve('out/renderer/index.html')
  assert.equal(isTrustedRendererUrl(`${pathToFileURL(entry)}?smoke=1`, { isPackaged: false, packagedRendererPath: entry }), true)
  assert.equal(isTrustedRendererUrl(pathToFileURL(resolve('out/renderer/other.html')).toString(), { isPackaged: false, packagedRendererPath: entry }), false)
})

test('download URL validation accepts only HTTP and HTTPS', () => {
  assert.equal(isSafeDownloadUrl('https://example.com/file.zip'), true)
  assert.equal(isSafeDownloadUrl('http://example.com/file.zip'), true)
  for (const url of [
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'blob:https://example.com/id',
    'chrome://version',
    'devtools://devtools/bundled',
    'about:blank',
    'not a url'
  ]) {
    assert.equal(isSafeDownloadUrl(url), false, url)
  }
})
