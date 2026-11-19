import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { createZstdDecompress } from 'node:zlib'

// The Video & Audio module ships as a POSIX tar stream compressed with zstd.
// Extraction accepts only regular files and directories, writes every file
// exclusively into a fresh staging directory and checks each byte against the
// runtime inventory that the signed release manifest pins by digest. Links,
// devices, sparse entries and anything outside the inventory are rejected.

const BLOCK = 512
const MAX_PATH_LENGTH = 180
const RUNTIME_MANIFEST_NAME = 'runtime-manifest.json'
const MAX_RUNTIME_MANIFEST_BYTES = 4 * 1024 * 1024
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const SHA256 = /^[a-f0-9]{64}$/

export interface ArchiveInventoryFile {
  path: string
  size: number
  sha256: string
}

export interface ArchiveLimits {
  // Digest and size of runtime-manifest.json, pinned by the signed manifest.
  runtimeManifestSha256: string
  runtimeManifestSize: number
  unpackedSize: number
  fileCount: number
}

export interface ArchiveProgress {
  extractedBytes: number
  totalBytes: number
}

export interface ExtractedArchive {
  runtimeManifest: Record<string, unknown>
  files: number
  bytes: number
}

export class ModuleArchiveError extends Error {
  readonly code = 'archive'
}

function reject(message: string): never {
  throw new ModuleArchiveError(message)
}

export function validateModuleRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH) reject('Archive entry path is invalid.')
  if (/[\\:*?"<>|\u0000-\u001f]/.test(value) || value.startsWith('/')) reject(`Archive entry path is unsafe: ${value}`)
  const segments = value.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) {
      reject(`Archive entry path is unsafe: ${value}`)
    }
  }
  return value
}

function inventoryFrom(runtimeManifest: Record<string, unknown>, limits: ArchiveLimits): Map<string, ArchiveInventoryFile> {
  const files = runtimeManifest.files
  if (!Array.isArray(files) || files.length === 0 || files.length + 1 !== limits.fileCount) reject('Runtime inventory does not match the signed file count.')
  const inventory = new Map<string, ArchiveInventoryFile>()
  let total = limits.runtimeManifestSize
  for (const record of files as Partial<ArchiveInventoryFile>[]) {
    const relativePath = validateModuleRelativePath(record?.path)
    if (relativePath === RUNTIME_MANIFEST_NAME || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256) ||
        !Number.isSafeInteger(record.size) || (record.size as number) < 0) {
      reject('Runtime inventory contains an invalid file record.')
    }
    const key = relativePath.toLowerCase()
    if (inventory.has(key)) reject(`Runtime inventory lists a duplicate path: ${relativePath}`)
    inventory.set(key, { path: relativePath, size: record.size as number, sha256: record.sha256 })
    total += record.size as number
  }
  if (total !== limits.unpackedSize) reject('Runtime inventory does not match the signed unpacked size.')
  return inventory
}

function octal(header: Buffer, offset: number, length: number): number {
  const raw = header.subarray(offset, offset + length)
  if (raw[0] & 0x80) reject('Archive uses an unsupported numeric encoding.')
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim()
  if (!/^[0-7]*$/.test(text)) reject('Archive header contains an invalid number.')
  const value = text ? Number.parseInt(text, 8) : 0
  if (!Number.isSafeInteger(value)) reject('Archive header number is out of range.')
  return value
}

function headerString(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

function verifyHeaderChecksum(header: Buffer): void {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]
  if (sum !== octal(header, 148, 8)) reject('Archive header checksum is invalid.')
}

function parsePax(data: Buffer): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) reject('Archive extended header is malformed.')
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) reject('Archive extended header is malformed.')
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals < 1) reject('Archive extended header is malformed.')
    const key = record.slice(0, equals)
    const value = record.slice(equals + 1)
    if (key === 'path') result.path = value
    else if (key === 'size') {
      if (!/^\d+$/.test(value)) reject('Archive extended size is invalid.')
      result.size = Number(value)
    } else if (key !== 'mtime' && key !== 'atime' && key !== 'ctime') {
      reject(`Archive extended header uses an unsupported key: ${key}`)
    }
    offset += length
  }
  return result
}

// Incremental byte reader over the decompressed stream. Reading never buffers
// more than one entry's metadata; file bodies are forwarded chunk by chunk.
class StreamReader {
  private buffered: Buffer[] = []
  private bufferedLength = 0
  private ended = false
  private readonly iterator: AsyncIterator<Buffer>

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false
    const next = await this.iterator.next()
    if (next.done) {
      this.ended = true
      return false
    }
    this.buffered.push(next.value)
    this.bufferedLength += next.value.length
    return true
  }

  async read(length: number): Promise<Buffer> {
    while (this.bufferedLength < length) {
      if (!(await this.fill())) reject('Archive ended unexpectedly.')
    }
    const joined = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered)
    const result = joined.subarray(0, length)
    const rest = joined.subarray(length)
    this.buffered = rest.length ? [rest] : []
    this.bufferedLength = rest.length
    return result
  }

  // Yields up to `length` bytes in source-sized slices without concatenation.
  async *chunks(length: number): AsyncGenerator<Buffer> {
    let remaining = length
    while (remaining > 0) {
      if (this.bufferedLength === 0 && !(await this.fill())) reject('Archive ended unexpectedly.')
      const head = this.buffered.shift() as Buffer
      this.bufferedLength -= head.length
      if (head.length > remaining) {
        this.buffered.unshift(head.subarray(remaining))
        this.bufferedLength += head.length - remaining
        yield head.subarray(0, remaining)
        remaining = 0
      } else {
        remaining -= head.length
        yield head
      }
    }
  }

  async skip(length: number): Promise<void> {
    for await (const chunk of this.chunks(length)) void chunk
  }

  // Tar writers may pad the stream to a blocking factor with zero bytes.
  async restIsZeroPadding(): Promise<boolean> {
    for (;;) {
      for (const chunk of this.buffered) if (chunk.some((byte) => byte !== 0)) return false
      this.buffered = []
      this.bufferedLength = 0
      if (!(await this.fill())) return true
    }
  }
}

async function writeExclusive(target: string, body: AsyncGenerator<Buffer>, onBytes: (count: number) => void): Promise<string> {
  const hash = createHash('sha256')
  let handle: FileHandle | undefined
  try {
    handle = await open(target, 'wx')
    for await (const chunk of body) {
      hash.update(chunk)
      await handle.write(chunk)
      onBytes(chunk.length)
    }
  } finally {
    await handle?.close()
  }
  return hash.digest('hex')
}

export async function extractModuleArchive(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits,
  options: { signal?: AbortSignal; onProgress?: (progress: ArchiveProgress) => void } = {}
): Promise<ExtractedArchive> {
  const root = path.resolve(destination)
  const decompressor = createZstdDecompress()
  const source = createReadStream(archivePath)
  const stream = source.pipe(decompressor)
  source.once('error', (error) => decompressor.destroy(error))
  // Bound total decompressed output: inventory bytes plus at most three
  // headers and padding per entry plus the end-of-archive marker.
  const decompressedLimit = limits.unpackedSize + limits.fileCount * BLOCK * 4 + BLOCK * 64
  let decompressed = 0
  const guarded = (async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Cancelled.')
      decompressed += chunk.length
      if (decompressed > decompressedLimit) reject('Archive expands beyond its signed size.')
      yield chunk
    }
  })()
  const reader = new StreamReader(guarded)
  const seen = new Set<string>()
  const createdDirectories = new Set<string>([root.toLowerCase()])
  let inventory: Map<string, ArchiveInventoryFile> | undefined
  let runtimeManifest: Record<string, unknown> | undefined
  let extractedBytes = 0
  let files = 0
  let pax: { path?: string; size?: number } | undefined
  const progress = (count: number): void => {
    extractedBytes += count
    options.onProgress?.({ extractedBytes, totalBytes: limits.unpackedSize })
  }

  const ensureDirectory = async (directory: string): Promise<void> => {
    const key = directory.toLowerCase()
    if (createdDirectories.has(key)) return
    await mkdir(directory, { recursive: true })
    createdDirectories.add(key)
  }

  try {
    for (;;) {
      const header = await reader.read(BLOCK)
      if (header.every((byte) => byte === 0)) {
        const second = await reader.read(BLOCK)
        if (!second.every((byte) => byte === 0)) reject('Archive end marker is malformed.')
        break
      }
      verifyHeaderChecksum(header)
      if (header.subarray(257, 262).toString('ascii') !== 'ustar') reject('Archive entry is not a POSIX tar header.')
      const type = String.fromCharCode(header[156] || 0x30)
      let size = octal(header, 124, 12)
      const padded = Math.ceil(size / BLOCK) * BLOCK
      if (type === 'x') {
        if (pax || size > 64 * 1024) reject('Archive extended header is invalid.')
        pax = parsePax(await reader.read(size))
        await reader.skip(padded - size)
        continue
      }
      const prefix = headerString(header, 345, 155)
      const name = pax?.path ?? (prefix ? `${prefix}/${headerString(header, 0, 100)}` : headerString(header, 0, 100))
      if (pax?.size !== undefined) size = pax.size
      pax = undefined
      const entryPadded = Math.ceil(size / BLOCK) * BLOCK

      if (type === '5') {
        if (size !== 0) reject('Archive directory entry has content.')
        const relativePath = validateModuleRelativePath(name.replace(/\/$/, ''))
        const target = path.resolve(root, ...relativePath.split('/'))
        if (!target.startsWith(`${root}${path.sep}`)) reject('Archive entry escapes its destination.')
        await ensureDirectory(target)
        continue
      }
      if (type !== '0') reject(`Archive contains an unsupported entry type: ${JSON.stringify(type)}`)

      const relativePath = validateModuleRelativePath(name)
      const key = relativePath.toLowerCase()
      if (seen.has(key)) reject(`Archive contains a duplicate path: ${relativePath}`)
      seen.add(key)
      const target = path.resolve(root, ...relativePath.split('/'))
      if (!target.startsWith(`${root}${path.sep}`)) reject('Archive entry escapes its destination.')

      if (!inventory) {
        // runtime-manifest.json must be first so every later byte is checked
        // against an inventory whose digest the signed manifest pinned.
        if (relativePath !== RUNTIME_MANIFEST_NAME || size !== limits.runtimeManifestSize || size > MAX_RUNTIME_MANIFEST_BYTES) {
          reject('Archive must start with its pinned runtime manifest.')
        }
        const body = await reader.read(size)
        if (createHash('sha256').update(body).digest('hex') !== limits.runtimeManifestSha256) reject('Runtime manifest does not match the signed digest.')
        try {
          runtimeManifest = JSON.parse(body.toString('utf8')) as Record<string, unknown>
        } catch {
          reject('Runtime manifest is not valid JSON.')
        }
        inventory = inventoryFrom(runtimeManifest, limits)
        const handle = await open(target, 'wx')
        try { await handle.write(body) } finally { await handle.close() }
        progress(size)
        files += 1
        await reader.skip(entryPadded - size)
        continue
      }

      const record = inventory.get(key)
      if (!record || record.path !== relativePath) reject(`Archive contains a file outside the runtime inventory: ${relativePath}`)
      if (record.size !== size) reject(`Archive entry size does not match the runtime inventory: ${relativePath}`)
      await ensureDirectory(path.dirname(target))
      const digest = await writeExclusive(target, reader.chunks(size), progress)
      if (digest !== record.sha256) reject(`Archive entry failed integrity verification: ${relativePath}`)
      files += 1
      await reader.skip(entryPadded - size)
    }
    if (!inventory || !runtimeManifest) reject('Archive is empty.')
    if (files !== limits.fileCount || extractedBytes !== limits.unpackedSize) reject('Archive is missing runtime files.')
    if (!(await reader.restIsZeroPadding())) reject('Archive has data after its end marker.')
    return { runtimeManifest, files, bytes: extractedBytes }
  } finally {
    source.destroy()
    decompressor.destroy()
  }
}
