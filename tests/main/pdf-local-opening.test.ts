import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('local PDF opening stays on a narrow validated main-process resource path', () => {
  const resources = source('src/main/pdf-resources.ts')
  const ipc = source('src/main/ipc/pdf.ts')
  assert.match(resources, /realpath\(inputPath\)/)
  assert.match(resources, /extname\(canonicalPath\)\.toLowerCase\(\) !== '\.pdf'/)
  assert.match(resources, /header\.toString\('latin1'\) !== '%PDF-'/)
  assert.match(resources, /ownsPath: false/)
  assert.match(resources, /if \(record\.ownsPath && record\.path\)/)
  assert.match(ipc, /vast:pdf:open-local-file/)
  assert.match(ipc, /senderWindowFor\(event\)/)
})

test('omnibar drop resolves File paths only in preload and opens the scoped viewer route', () => {
  const preload = source('src/preload/index.ts')
  const addressBar = source('src/renderer/components/browser/AddressBar.tsx')
  assert.match(preload, /webUtils\.getPathForFile\(file\)/)
  assert.match(preload, /vast:pdf:open-local-file/)
  assert.doesNotMatch(addressBar, /\.path\b/)
  assert.match(addressBar, /window\.vast\.pdf\.openLocalFile\(file\)/)
  assert.match(addressBar, /Drop PDF to open/)
})

test('ordinary downloads publish a progressing item before waiting for updated events', () => {
  const downloads = source('src/main/downloads.ts')
  const initial = downloads.indexOf("normalizeDownload(item, id, 'progressing')")
  const listener = downloads.indexOf("item.on('updated'")
  assert.ok(initial >= 0 && listener > initial)
  assert.match(downloads.slice(initial, listener), /publishDownload\(initialWindow, initialDownload, false\)/)
  assert.match(downloads, /windowRegistry\.vastWindowForWebContents\(initiatingContents\)/)
})
