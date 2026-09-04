import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { inspectPeCertificateTableBuffer } = require('../../scripts/windows-authenticode.cjs')

function pe32(certificateOffset = 0, certificateSize = 0) {
  const bytes = Buffer.alloc(Math.max(0x400, certificateOffset + certificateSize))
  bytes.write('MZ', 0, 'latin1')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'latin1')
  bytes.writeUInt16LE(0xe0, 0x80 + 20)
  const optionalHeader = 0x80 + 24
  bytes.writeUInt16LE(0x10b, optionalHeader)
  bytes.writeUInt32LE(16, optionalHeader + 92)
  bytes.writeUInt32LE(certificateOffset, optionalHeader + 96 + (4 * 8))
  bytes.writeUInt32LE(certificateSize, optionalHeader + 96 + (4 * 8) + 4)
  return bytes
}

test('PE certificate-table inspection identifies a truly unsigned executable', () => {
  assert.deepEqual(inspectPeCertificateTableBuffer(pe32()), {
    certificateTablePresent: false,
    certificateOffset: 0,
    certificateSize: 0
  })
})

test('PE certificate-table inspection rejects signature-bearing and malformed layouts', () => {
  assert.deepEqual(inspectPeCertificateTableBuffer(pe32(0x400, 8)), {
    certificateTablePresent: true,
    certificateOffset: 0x400,
    certificateSize: 8
  })
  assert.throws(() => inspectPeCertificateTableBuffer(pe32(0x401, 8)), /certificate table is malformed/)
  assert.throws(() => inspectPeCertificateTableBuffer(Buffer.from('not a PE')), /valid MZ executable/)
})
