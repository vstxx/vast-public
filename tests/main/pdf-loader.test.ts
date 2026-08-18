import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_PDF_BYTES, MAX_PDF_REDIRECTS, loadPdfFromUrl } from '../../src/main/pdf-loader.ts'

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')

function response(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(bytes, init)
}

const publicResolver = async (): Promise<readonly string[]> => ['93.184.216.34']

test('loads a valid small PDF', async () => {
  const result = await loadPdfFromUrl('https://example.com/doc.pdf', {
    fetchImpl: async () => response(pdfBytes, { headers: { 'content-length': String(pdfBytes.byteLength), 'content-type': 'application/pdf' } }),
    resolveHost: publicResolver
  })
  assert.equal(result.data.byteLength, pdfBytes.byteLength)
  assert.equal(result.mimeType, 'application/pdf')
})

test('loads a PDF without content-length when stream stays under the limit', async () => {
  const result = await loadPdfFromUrl('https://example.com/doc.pdf', {
    fetchImpl: async () => response(pdfBytes, { headers: { 'content-type': 'application/octet-stream' } }),
    resolveHost: publicResolver
  })
  assert.equal(result.data.byteLength, pdfBytes.byteLength)
})

test('rejects content-length over the PDF limit before reading', async () => {
  await assert.rejects(
    () =>
      loadPdfFromUrl('https://example.com/doc.pdf', {
        fetchImpl: async () => response(pdfBytes, { headers: { 'content-length': String(MAX_PDF_BYTES + 1) } }),
        resolveHost: publicResolver
      }),
    /too large/i
  )
})

test('rejects streams that exceed the PDF limit', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('%PDF'))
      controller.enqueue(new Uint8Array(MAX_PDF_BYTES))
      controller.enqueue(new Uint8Array(2))
      controller.close()
    }
  })
  await assert.rejects(
    () =>
      loadPdfFromUrl('https://example.com/doc.pdf', {
        fetchImpl: async () => new Response(stream),
        resolveHost: publicResolver
      }),
    /too large/i
  )
})

test('rejects non-PDF payloads and fetch failures', async () => {
  await assert.rejects(
    () =>
      loadPdfFromUrl('https://example.com/doc.pdf', {
        fetchImpl: async () => response(new TextEncoder().encode('html')),
        resolveHost: publicResolver
      }),
    /pdf/i
  )
  await assert.rejects(
    () =>
      loadPdfFromUrl('https://example.com/doc.pdf', {
        fetchImpl: async () => {
          throw new Error('network down')
        },
        resolveHost: publicResolver
      }),
    /network down/i
  )
})

test('follows only manually validated public redirects', async () => {
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = []
  const result = await loadPdfFromUrl('https://example.com/start', {
    resolveHost: publicResolver,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: '/doc.pdf' } })
        : response(pdfBytes, { headers: { 'content-type': 'application/pdf' } })
    }
  })
  assert.equal(result.data.byteLength, pdfBytes.byteLength)
  assert.deepEqual(requests, [
    { url: 'https://example.com/start', redirect: 'manual' },
    { url: 'https://example.com/doc.pdf', redirect: 'manual' }
  ])
})

test('rejects local, private, link-local, and private-DNS PDF targets', async () => {
  const blocked = [
    'http://127.0.0.1/doc.pdf',
    'http://10.0.0.1/doc.pdf',
    'http://172.16.0.1/doc.pdf',
    'http://192.168.1.2/doc.pdf',
    'http://169.254.1.2/doc.pdf',
    'http://[::1]/doc.pdf',
    'http://[fe80::1]/doc.pdf',
    'http://printer.local/doc.pdf'
  ]
  for (const url of blocked) {
    await assert.rejects(() => loadPdfFromUrl(url, { fetchImpl: async () => response(pdfBytes) }), /public http/i)
  }
  await assert.rejects(
    () => loadPdfFromUrl('https://internal.example/doc.pdf', { fetchImpl: async () => response(pdfBytes), resolveHost: async () => ['10.1.2.3'] }),
    /public http/i
  )
})

test('test-only override permits only a literal loopback fixture', async () => {
  const result = await loadPdfFromUrl('http://127.0.0.1/viewer.pdf', {
    allowLiteralLoopbackForTests: true,
    fetchImpl: async () => response(pdfBytes, { headers: { 'content-type': 'application/pdf' } })
  })
  assert.equal(result.data.byteLength, pdfBytes.byteLength)

  await assert.rejects(
    () =>
      loadPdfFromUrl('http://10.0.0.1/secret.pdf', {
        allowLiteralLoopbackForTests: true,
        fetchImpl: async () => response(pdfBytes)
      }),
    /public http/i
  )
})

test('rejects redirects to private targets and redirect loops', async () => {
  let privateRedirectRequests = 0
  await assert.rejects(
    () => loadPdfFromUrl('https://example.com/doc.pdf', {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        privateRedirectRequests += 1
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
      }
    }),
    /public http/i
  )
  assert.equal(privateRedirectRequests, 1)

  let loopRequests = 0
  await assert.rejects(
    () => loadPdfFromUrl('https://example.com/doc.pdf', {
      resolveHost: publicResolver,
      fetchImpl: async () => {
        loopRequests += 1
        return new Response(null, { status: 302, headers: { location: '/doc.pdf' } })
      }
    }),
    /redirect limit/i
  )
  assert.equal(loopRequests, MAX_PDF_REDIRECTS + 1)
})
