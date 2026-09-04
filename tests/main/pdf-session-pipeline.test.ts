import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
}

const sessions = source('src/main/sessions.ts')
const downloads = source('src/main/downloads.ts')
const resources = source('src/main/pdf-resources.ts')
const pdfIpc = source('src/main/ipc/pdf.ts')
const preload = source('src/preload/index.ts')
const webview = source('src/renderer/components/browser/WebviewSurface.tsx')

test('PDF navigation is captured from the original guest response exactly once', () => {
  assert.match(sessions, /webRequest\.onHeadersReceived/)
  assert.match(sessions, /classifyPdfNavigationResponse\(details\)/)
  assert.match(sessions, /registerPdfNavigationResponse/)
  assert.match(sessions, /pdfAttachmentHeaders/)
  assert.match(downloads, /if \(claimPdfDownload\(item, initiatingContents\)\) return/)
  assert.doesNotMatch(pdfIpc, /vast:pdf:load|loadPdfFromUrl|fetch\(/)
})

test('captured files are bounded, validated, range-read and window scoped', () => {
  assert.match(resources, /MAX_PDF_BYTES = 1024 \* 1024 \* 1024/)
  assert.match(resources, /header\.toString\('latin1'\) !== '%PDF-'/)
  assert.match(resources, /record\.ownerWebContentsId !== ownerWebContentsId/)
  assert.match(resources, /MAX_RANGE_BYTES/)
  assert.match(resources, /Buffer\.allocUnsafe\(end - begin\)/)
  assert.match(resources, /MAX_RESOURCES = 32/)
  assert.match(resources, /READY_TTL_MS/)
})

test('renderer receives only scoped capture metadata and explicit PDF operations', () => {
  assert.match(preload, /vast:pdf:capture/)
  assert.match(preload, /vast:pdf:read-range/)
  assert.match(preload, /vast:pdf:save/)
  assert.match(preload, /vast:pdf:open-external-fallback/)
  assert.match(webview, /capture\.guestWebContentsId !== currentGuestId/)
  assert.match(webview, /resourceId: capture\.id/)
  assert.doesNotMatch(preload, /vast:pdf:load/)
})

test('a completed download cannot strand the guest before its next navigation', () => {
  assert.match(webview, /if \(currentUrl === tab\.url\) return/)
  assert.doesNotMatch(webview, /if \(!currentUrl \|\| currentUrl === tab\.url\) return/)
  assert.match(webview, /if \(tab\.url !== initialUrlRef\.current\)/)
  assert.match(webview, /void webview\.loadURL\(tab\.url\)/)
})
