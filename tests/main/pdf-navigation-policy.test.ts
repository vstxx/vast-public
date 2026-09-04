import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyPdfNavigationResponse, pdfAttachmentHeaders } from '../../src/shared/pdf-navigation-policy.ts'

function classify(url: string, headers: Record<string, string[]>, resourceType = 'mainFrame') {
  return classifyPdfNavigationResponse({ url, resourceType, statusCode: 200, responseHeaders: headers })
}

test('captures authenticated-style PDF endpoints by MIME without relying on a .pdf URL', () => {
  const result = classify('https://example.com/download?id=123', {
    'Content-Type': ['application/pdf; charset=binary'],
    'Content-Length': ['4096']
  })
  assert.equal(result.capture, true)
  assert.equal(result.mimeType, 'application/pdf')
  assert.equal(result.contentLength, 4096)
})

test('captures Content-Disposition PDF exports and decodes their filename', () => {
  const result = classify('https://office.example/export', {
    'content-type': ['application/octet-stream'],
    'content-disposition': ["attachment; filename*=UTF-8''Quarterly%20report.pdf"]
  })
  assert.equal(result.capture, true)
  assert.equal(result.filename, 'Quarterly report.pdf')
})

test('uses a conservative URL fallback and never routes HTML masquerading behind .pdf', () => {
  assert.equal(classify('https://example.com/file.pdf?token=one-shot', { 'content-type': ['application/octet-stream'] }).capture, true)
  assert.equal(classify('https://example.com/file.pdf?token=expired', { 'content-type': ['text/html'] }).capture, false)
  assert.equal(classify('https://example.com/file.pdf', { 'content-type': ['application/json'] }).capture, false)
})

test('captures only successful top-level HTTP(S) responses', () => {
  assert.equal(classify('https://example.com/file.pdf', { 'content-type': ['application/pdf'] }, 'xhr').capture, false)
  assert.equal(classifyPdfNavigationResponse({
    url: 'https://example.com/file.pdf', resourceType: 'mainFrame', statusCode: 403,
    responseHeaders: { 'content-type': ['application/pdf'] }
  }).capture, false)
  assert.equal(classify('file:///private/document.pdf', { 'content-type': ['application/pdf'] }).capture, false)
})

test('attachment rewrite preserves other headers and sanitizes the filename', () => {
  const result = pdfAttachmentHeaders({
    'Content-Type': ['application/pdf'],
    'content-disposition': ['inline'],
    ETag: ['abc']
  }, 'bad\r\n/name.pdf')
  assert.deepEqual(result['Content-Type'], ['application/pdf'])
  assert.deepEqual(result.ETag, ['abc'])
  assert.deepEqual(result['Content-Disposition'], ['attachment; filename="bad___name.pdf"'])
  assert.equal(Object.keys(result).filter((name) => name.toLowerCase() === 'content-disposition').length, 1)
})
