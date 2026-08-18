import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pdfImplementationSource = readFileSync(new URL('../../src/main/ipc/pdf-implementation.ts', import.meta.url), 'utf8')
const viewerSource = readFileSync(new URL('../../src/renderer/components/pdf/PdfViewerPage.tsx', import.meta.url), 'utf8')

test('active PDF print path uses Chromium native PDF rendering', () => {
  const openPreview = pdfImplementationSource.slice(pdfImplementationSource.indexOf('async function openPdfPrintPreview'))
  assert.match(openPreview, /loadURL\(pathToFileURL\(pdfPath\)/)
  assert.doesNotMatch(openPreview, /canvas|toBlob|pdfPrintHtml|pdf\.mjs/)
  assert.match(openPreview, /plugins: true/)
  assert.match(openPreview, /rm\(tempDirectory/)
})

test('renderer sends original PDF bytes instead of retaining per-page PNGs', () => {
  const requestPrint = viewerSource.slice(viewerSource.indexOf('const requestPdfPrint'), viewerSource.indexOf('useEffect(() => {', viewerSource.indexOf('const requestPdfPrint')))
  assert.match(requestPrint, /window\.vast\.pdf\.print\(bytes/)
  assert.doesNotMatch(requestPrint, /createElement\('canvas'\)|createObjectURL|toBlob/)
  assert.doesNotMatch(viewerSource, /printPreviewPages/)
})
