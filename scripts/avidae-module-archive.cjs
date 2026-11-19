// Deterministic writer for the Video & Audio module archive: POSIX (ustar +
// pax path records) tar, compressed with zstd. Entries are regular files only,
// runtime-manifest.json first, then the inventory in sorted order, with fixed
// metadata so the same runtime always produces the same archive bytes.
const { createReadStream, createWriteStream } = require('node:fs')
const { createZstdCompress, constants } = require('node:zlib')
const { pipeline } = require('node:stream/promises')

const BLOCK = 512

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body)
  return `${length}${body}`
}

function header(name, size, type) {
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(0, 12), 136, 'ascii')
  block.fill(0x20, 148, 156)
  block.write(type, 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

function padding(size) {
  const remainder = size % BLOCK
  return remainder ? Buffer.alloc(BLOCK - remainder) : Buffer.alloc(0)
}

function entryHeaders(relativePath, size) {
  if (Buffer.byteLength(relativePath) <= 100) return [header(relativePath, size, '0')]
  const pax = Buffer.from(paxRecord('path', relativePath), 'utf8')
  return [header('PaxHeader', pax.length, 'x'), pax, padding(pax.length), header(relativePath.slice(-100), size, '0')]
}

// entries: [{ path, data?: Buffer, source?: string, size }]
async function* tarStream(entries) {
  for (const entry of entries) {
    yield* entryHeaders(entry.path, entry.size)
    if (entry.data) yield entry.data
    else {
      let written = 0
      for await (const chunk of createReadStream(entry.source, { highWaterMark: 1024 * 1024 })) {
        written += chunk.length
        yield chunk
      }
      if (written !== entry.size) throw new Error(`File changed while archiving: ${entry.path}`)
    }
    yield padding(entry.size)
  }
  yield Buffer.alloc(BLOCK * 2)
}

async function writeModuleArchive(entries, output, options = {}) {
  const compressor = createZstdCompress({
    params: {
      [constants.ZSTD_c_compressionLevel]: options.level ?? 19,
      [constants.ZSTD_c_checksumFlag]: 1,
      ...(options.workers ? { [constants.ZSTD_c_nbWorkers]: options.workers } : {})
    }
  })
  await pipeline(tarStream(entries), compressor, createWriteStream(output))
}

module.exports = { writeModuleArchive, tarStream, header, BLOCK }
