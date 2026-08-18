import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  detectDecoyDoubleExtension,
  detectExecutableMimeMismatch
} from '../../src/shared/download-security.ts'

const downloadsSource = readFileSync(new URL('../../src/main/downloads.ts', import.meta.url), 'utf8')

test('only executable outer extensions trigger double-extension warnings', () => {
  assert.equal(detectDecoyDoubleExtension('tool.v1.exe'), null)
  assert.match(detectDecoyDoubleExtension('invoice.pdf.exe') ?? '', /Double extension/)
  assert.match(detectDecoyDoubleExtension('photo.jpg.scr') ?? '', /Double extension/)
  assert.match(detectDecoyDoubleExtension('document.docx.lnk') ?? '', /Double extension/)
})

test('generic binary MIME is not treated as an executable mismatch', () => {
  assert.equal(detectExecutableMimeMismatch('archive.zip', 'application/octet-stream'), null)
  assert.equal(detectExecutableMimeMismatch('photo.jpg', 'application/octet-stream'), null)
  assert.match(detectExecutableMimeMismatch('document.pdf', 'application/x-msdownload') ?? '', /does not match/)
})

test('downloads remain quarantined through scan and hash verification', () => {
  assert.match(downloadsSource, /scanStatus = 'scanning'/)
  assert.match(downloadsSource, /currentHash !== item\.scannedSha256/)
  assert.match(downloadsSource, /targetSession\.isPersistent\(\)/)
  assert.match(downloadsSource, /await dialog\.showMessageBox\(window/)
  assert.match(downloadsSource, /scanStatus === 'scan-unavailable' \|\| item\.scanStatus === 'scan-failed'/)
})
