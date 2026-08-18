import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { downloadRelayMedia, RELAY_MAX_ASSET_BYTES } from '../../src/main/relay/media.ts'

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PNG_SHA = createHash('sha256').update(PNG_BYTES).digest('hex')

function pngMetadata(overrides: Record<string, unknown> = {}) {
  return { id: 'relay-test.png', mime: 'image/png' as const, sha256: PNG_SHA, ...overrides }
}

test('Relay downloads only the signed asset path and verifies MIME, magic and SHA-256', async () => {
  let requested = ''
  const result = await downloadRelayMedia('https://relay-staging.vastbrowser.com', pngMetadata(), async (input) => {
    requested = String(input)
    return new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG_BYTES.byteLength) } })
  })
  assert.equal(requested, 'https://relay-staging.vastbrowser.com/v1/assets/relay-test.png')
  assert.equal(result.mime, 'image/png')
  assert.equal(result.sha256, PNG_SHA)
  assert.deepEqual(result.bytes, PNG_BYTES)
})

test('Relay rejects missing, oversized, wrong-MIME, wrong-magic and wrong-hash media', async () => {
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata(), async () => new Response(null, { status: 404 })), /404/)
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata(), async () => new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/webp' } })), /MIME/)
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata(), async () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'Content-Type': 'image/png' } })), /magic/)
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata({ sha256: 'b'.repeat(64) }), async () => new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } })), /SHA-256/)
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata(), async () => new Response(PNG_BYTES, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(RELAY_MAX_ASSET_BYTES + 1) }
  })), /oversized/)
  const streamedOversize = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(RELAY_MAX_ASSET_BYTES))
      controller.enqueue(Uint8Array.of(1))
      controller.close()
    }
  })
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata(), async () => new Response(streamedOversize, {
    headers: { 'Content-Type': 'image/png' }
  })), /size limit/)
})

test('Relay aborts a stalled media fetch at its short timeout', async () => {
  await assert.rejects(() => downloadRelayMedia('https://relay.invalid', pngMetadata(), (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }), 10), /Aborted/)
})
