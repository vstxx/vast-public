import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const VAST_BACKUP_FORMAT_VERSION = 1
const maxArchiveBytes = 512 * 1024 * 1024
const maxEntryBytes = 256 * 1024 * 1024
// A valid Vast 1.0.11 export can exceed 1 GiB after extraction while still
// fitting within the archive and per-entry limits. Keep the zip-bomb guard,
// but make it large enough to round-trip backups created by that release.
const maxTotalUncompressedBytes = 2 * 1024 * 1024 * 1024
const maxArchiveEntries = 10_000
const maxCompressionRatio = 250
const retryBackoffMs = [50, 150, 350, 750]
const retryableFileErrorCodes = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT'])
const criticalVastDataUnavailableMessage = 'Could not export Vast profile data because vast-data.json is locked or unavailable.'
const passwordVaultKeyUnavailableMessage = 'Could not export the password vault because its matching Local State encryption key is locked or unavailable. No backup was created.'
const legacyProductMetadataFiles = new Set(['license-cache.json', 'license-device.json'])
const volatileDirectoryNames = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'shadercache',
  'crashpad',
  'crash reports',
  'updaterdownloads',
  'updaterlogs',
  'temp',
  'tmp'
])

export interface VastBackupChecksum {
  sha256: string
  sizeBytes: number
}

export interface VastBackupSkippedFile {
  path: string
  reason: string
}

export interface VastBackupManifest {
  product: 'Vast'
  appId: string
  exportFormatVersion: number
  appVersion: string
  platform: string
  createdAt: string
  sourceDataPath?: string
  includedSections: string[]
  excludedSections: string[]
  includedFileCount: number
  skippedFileCount: number
  skippedFiles: VastBackupSkippedFile[]
  vastDataIncluded: boolean
  passwordVaultIncluded: boolean
  checksums: Record<string, VastBackupChecksum>
  warnings: string[]
}

export interface VastBackupFileOperationHooksForTests {
  beforeCopy?: (relativePath: string, attempt: number) => void | Promise<void>
  beforeRead?: (relativePath: string, attempt: number) => void | Promise<void>
}

export interface CreateVastBackupOptions {
  dataRoot: string
  destinationPath: string
  appVersion: string
  appId: string
  platform: string
  extraEntriesForTests?: Array<{ path: string; data: string | Uint8Array }>
  manifestTransformForTests?: (manifest: VastBackupManifest) => void
  archiveEntryOverridesForTests?: Record<string, string | Uint8Array>
  omitArchiveEntriesForTests?: string[]
  fileOperationHooksForTests?: VastBackupFileOperationHooksForTests
}

export interface ExtractVastBackupOptions {
  beforeActivateForTests?: () => void | Promise<void>
}

export interface CreateVastBackupReport {
  ok: true
  path: string
  includedFiles: string[]
  skippedFiles: string[]
  includedFileCount: number
  skippedFileCount: number
  skippedFileDetails: VastBackupSkippedFile[]
  vastDataIncluded: boolean
  passwordVaultIncluded: boolean
  manifest: VastBackupManifest
}

interface ZipEntryInput {
  path: string
  data: Uint8Array
}

interface ZipEntry extends ZipEntryInput {
  compressed: Buffer
  crc32: number
  offset: number
  compressionMethod: number
}

function normalizeArchivePath(pathname: string): string {
  return pathname.split(sep).join('/')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function fileErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fileFailureReason(action: string, error: unknown): string {
  const code = fileErrorCode(error)
  const message = fileErrorMessage(error)
  return code ? `${action} failed with ${code}: ${message}` : `${action} failed: ${message}`
}

function isRetryableFileError(error: unknown): boolean {
  const code = fileErrorCode(error)
  return Boolean(code && retryableFileErrorCodes.has(code))
}

async function withFileRetries<T>(
  operation: () => Promise<T>,
  beforeAttempt?: (attempt: number) => void | Promise<void>
): Promise<T> {
  let lastError: unknown
  for (let index = 0; index <= retryBackoffMs.length; index += 1) {
    try {
      await beforeAttempt?.(index + 1)
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryableFileError(error) || index === retryBackoffMs.length) throw error
      await delay(retryBackoffMs[index])
    }
  }
  throw lastError
}

function addSkippedFile(skippedFiles: VastBackupSkippedFile[], relativePath: string, reason: string): void {
  const normalized = normalizeArchivePath(relativePath || '.')
  if (skippedFiles.some((item) => item.path === normalized && item.reason === reason)) return
  skippedFiles.push({ path: normalized, reason })
}

function sortedSkippedFiles(skippedFiles: VastBackupSkippedFile[]): VastBackupSkippedFile[] {
  return [...skippedFiles].sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason))
}

function skippedFilePaths(skippedFiles: VastBackupSkippedFile[]): string[] {
  return [...new Set(skippedFiles.map((item) => item.path))].sort()
}

function isCriticalVastData(relativePath: string): boolean {
  return normalizeArchivePath(relativePath).toLowerCase() === 'vast-data.json'
}

function shouldSkipDataFile(relativePath: string): boolean {
  const normalized = normalizeArchivePath(relativePath)
  const parts = normalized.split('/').filter(Boolean)
  return parts.some((part) => volatileDirectoryNames.has(part.toLowerCase()))
}

function isLegacyProductMetadataPath(relativePath: string): boolean {
  const normalized = normalizeArchivePath(relativePath).toLowerCase()
  return legacyProductMetadataFiles.has(normalized) || [...legacyProductMetadataFiles].some((name) => normalized === `data/${name}`)
}

function isUpdaterProfileBackup(relativePath: string): boolean {
  const normalized = normalizeArchivePath(relativePath)
  return normalized.split('/').filter(Boolean)[0]?.toLowerCase() === 'backups'
}

function isKnownVolatileBackupEntry(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/')
  return normalized.startsWith('data/') && shouldSkipDataFile(normalized.slice('data/'.length))
}

const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
  let c = i
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[i] = c >>> 0
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function encodePath(pathname: string): Buffer {
  return Buffer.from(pathname, 'utf8')
}

function zipEntries(entries: ZipEntryInput[]): Buffer {
  let offset = 0
  const prepared: ZipEntry[] = entries.map((entry) => {
    const compressed = deflateRawSync(entry.data)
    const next: ZipEntry = {
      ...entry,
      compressed,
      compressionMethod: 8,
      crc32: crc32(entry.data),
      offset
    }
    const name = encodePath(entry.path)
    offset += 30 + name.length + compressed.length
    return next
  })

  const locals: Buffer[] = []
  for (const entry of prepared) {
    const name = encodePath(entry.path)
    locals.push(
      Buffer.concat([
        uint32(0x04034b50),
        uint16(20),
        uint16(0x0800),
        uint16(entry.compressionMethod),
        uint16(0),
        uint16(0),
        uint32(entry.crc32),
        uint32(entry.compressed.length),
        uint32(entry.data.length),
        uint16(name.length),
        uint16(0),
        name,
        entry.compressed
      ])
    )
  }

  const centralOffset = offset
  const central: Buffer[] = []
  for (const entry of prepared) {
    const name = encodePath(entry.path)
    const item = Buffer.concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0x0800),
      uint16(entry.compressionMethod),
      uint16(0),
      uint16(0),
      uint32(entry.crc32),
      uint32(entry.compressed.length),
      uint32(entry.data.length),
      uint16(name.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(entry.offset),
      name
    ])
    central.push(item)
    offset += item.length
  }
  const centralSize = offset - centralOffset

  return Buffer.concat([
    ...locals,
    ...central,
    Buffer.concat([
      uint32(0x06054b50),
      uint16(0),
      uint16(0),
      uint16(prepared.length),
      uint16(prepared.length),
      uint32(centralSize),
      uint32(centralOffset),
      uint16(0)
    ])
  ])
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('Invalid Vast backup archive.')
}

async function readArchiveWithinLimit(archivePath: string): Promise<Buffer> {
  const info = await stat(archivePath)
  if (!info.isFile() || info.size > maxArchiveBytes) throw new Error('Vast backup archive is too large.')
  return readFile(archivePath)
}

interface ParsedZipEntry {
  path: string
  compressed: Buffer
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  expectedCrc32: number
}

function parseZipEntryRecords(buffer: Buffer): ParsedZipEntry[] {
  if (buffer.length > maxArchiveBytes) throw new Error('Vast backup archive is too large.')
  const eocd = findEndOfCentralDirectory(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  if (count > maxArchiveEntries) throw new Error('Vast backup contains too many files.')
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset >= eocd) throw new Error('Invalid Vast backup central directory offset.')
  const entries: ParsedZipEntry[] = []
  const paths = new Set<string>()
  let totalUncompressedBytes = 0
  let cursor = centralOffset
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > eocd) throw new Error('Invalid Vast backup central directory bounds.')
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid Vast backup central directory.')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc32 = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd) throw new Error('Invalid Vast backup entry bounds.')
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (!name || paths.has(name)) throw new Error(`Duplicate or empty Vast backup entry: ${name || '[empty]'}`)
    paths.add(name)
    if ((flags & 0x0001) !== 0) throw new Error(`Encrypted Vast backup entries are not supported: ${name}`)
    if (uncompressedSize > maxEntryBytes) throw new Error(`Vast backup entry is too large: ${name}`)
    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > maxTotalUncompressedBytes) throw new Error('Vast backup expands beyond the allowed total size.')
    if (
      uncompressedSize > 1024 * 1024
      && compressedSize > 0
      && uncompressedSize / compressedSize > maxCompressionRatio
      && !isKnownVolatileBackupEntry(name)
    ) {
      throw new Error(`Vast backup entry has a suspicious compression ratio: ${name}`)
    }
    if (localOffset + 30 > centralOffset) throw new Error('Invalid Vast backup local entry offset.')
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid Vast backup local entry.')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > centralOffset) throw new Error(`Invalid compressed data bounds for ${name}.`)
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.push({
      path: name,
      compressed,
      compressedSize,
      uncompressedSize,
      compressionMethod: method,
      expectedCrc32
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function inflateZipEntry(entry: ParsedZipEntry): Buffer {
  const data = entry.compressionMethod === 8
    ? inflateRawSync(entry.compressed, { maxOutputLength: Math.min(maxEntryBytes, entry.uncompressedSize + 1) })
    : entry.compressionMethod === 0
      ? entry.compressed
      : undefined
  if (!data) throw new Error(`Unsupported Vast backup compression method for ${entry.path}.`)
  if (data.length !== entry.uncompressedSize) throw new Error(`Vast backup entry size mismatch: ${entry.path}`)
  if (crc32(data) !== entry.expectedCrc32) throw new Error(`Vast backup entry CRC mismatch: ${entry.path}`)
  return data
}

function parseZipEntries(buffer: Buffer): Array<{ path: string; data: Buffer }> {
  return parseZipEntryRecords(buffer).map((entry) => ({ path: entry.path, data: inflateZipEntry(entry) }))
}

function sectionForPath(pathname: string): string {
  const lower = pathname.toLowerCase()
  if (lower === 'vast-data.json') return 'Vast profile JSON'
  if (lower === 'password-vault.json') return 'Password vault'
  if (lower.startsWith('storage-backups/')) return 'Storage backups'
  if (lower === 'vast-network-devices.json') return 'Network Devices'
  if (lower.startsWith('avidae/')) return 'Video & Audio data'
  if (lower.includes('local storage') || lower.includes('indexeddb') || lower.includes('session')) return 'Browser profile state'
  return 'Other Vast data'
}

interface StagedDataRootReport {
  skippedFileDetails: VastBackupSkippedFile[]
}

interface CollectedStagedFiles {
  files: ZipEntryInput[]
  includedFiles: string[]
  checksums: Record<string, VastBackupChecksum>
}

async function copyLiveFileToStaging(input: {
  sourceRoot: string
  stagingRoot: string
  relativePath: string
  skippedFileDetails: VastBackupSkippedFile[]
  hooks?: VastBackupFileOperationHooksForTests
}): Promise<void> {
  const normalized = normalizeArchivePath(input.relativePath)
  const source = join(input.sourceRoot, input.relativePath)
  const destination = join(input.stagingRoot, input.relativePath)
  try {
    await mkdir(dirname(destination), { recursive: true })
    await withFileRetries(
      () => copyFile(source, destination),
      (attempt) => input.hooks?.beforeCopy?.(normalized, attempt)
    )
  } catch (error) {
    if (isCriticalVastData(normalized)) throw new Error(criticalVastDataUnavailableMessage)
    addSkippedFile(input.skippedFileDetails, normalized, fileFailureReason('Copy', error))
  }
}

async function collectSkippedLivePath(
  root: string,
  relativePath: string,
  skippedFileDetails: VastBackupSkippedFile[],
  reason: string
): Promise<void> {
  const absolute = join(root, relativePath)
  const normalized = normalizeArchivePath(relativePath)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await withFileRetries(() => lstat(absolute))
  } catch (error) {
    addSkippedFile(skippedFileDetails, normalized, `${reason} ${fileFailureReason('Inspect', error)}`)
    return
  }
  if (!info.isDirectory()) {
    addSkippedFile(skippedFileDetails, normalized, reason)
    return
  }
  let entries: string[]
  try {
    entries = await withFileRetries(() => readdir(absolute))
  } catch (error) {
    addSkippedFile(skippedFileDetails, normalized, `${reason} ${fileFailureReason('Read directory', error)}`)
    return
  }
  if (entries.length === 0) addSkippedFile(skippedFileDetails, normalized, reason)
  for (const entry of entries) await collectSkippedLivePath(root, join(relativePath, entry), skippedFileDetails, reason)
}

async function stageDataRootForBackup(
  dataRoot: string,
  stagingRoot: string,
  hooks?: VastBackupFileOperationHooksForTests
): Promise<StagedDataRootReport> {
  const sourceRoot = resolve(dataRoot)
  const skippedFileDetails: VastBackupSkippedFile[] = []

  await copyLiveFileToStaging({
    sourceRoot,
    stagingRoot,
    relativePath: 'vast-data.json',
    skippedFileDetails,
    hooks
  })

  async function visit(relativeRoot = ''): Promise<void> {
    const directory = relativeRoot ? join(sourceRoot, relativeRoot) : sourceRoot
    let entries: string[]
    try {
      entries = await withFileRetries(() => readdir(directory))
    } catch (error) {
      addSkippedFile(skippedFileDetails, normalizeArchivePath(relativeRoot || '.'), fileFailureReason('Read directory', error))
      return
    }

    for (const entry of entries) {
      const relativePath = relativeRoot ? join(relativeRoot, entry) : entry
      const normalized = normalizeArchivePath(relativePath)
      const lower = normalized.toLowerCase()
      if (lower === 'vast-data.json') continue
      if (isLegacyProductMetadataPath(normalized)) continue
      if (isUpdaterProfileBackup(relativePath)) {
        addSkippedFile(
          skippedFileDetails,
          normalized,
          'Updater profile backups are skipped to avoid including redundant copies of the Vast profile.'
        )
        continue
      }
      if (shouldSkipDataFile(relativePath) || lower.endsWith('.vastbackup')) {
        await collectSkippedLivePath(
          sourceRoot,
          relativePath,
          skippedFileDetails,
          shouldSkipDataFile(relativePath) ? 'Volatile browser/cache data is skipped.' : 'Existing backup archives are skipped.'
        )
        continue
      }

      const absolute = join(sourceRoot, relativePath)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await withFileRetries(() => lstat(absolute))
      } catch (error) {
        addSkippedFile(skippedFileDetails, normalized, fileFailureReason('Inspect', error))
        continue
      }
      if (info.isSymbolicLink()) {
        addSkippedFile(skippedFileDetails, normalized, 'Symbolic links are not included in Vast backups.')
        continue
      }
      if (info.isDirectory()) {
        await visit(relativePath)
        continue
      }
      if (!info.isFile()) continue
      if (info.size > maxEntryBytes) {
        addSkippedFile(skippedFileDetails, normalized, `File is larger than the ${maxEntryBytes} byte backup entry limit.`)
        continue
      }
      await copyLiveFileToStaging({
        sourceRoot,
        stagingRoot,
        relativePath,
        skippedFileDetails,
        hooks
      })
    }
  }

  await visit()
  return { skippedFileDetails: sortedSkippedFiles(skippedFileDetails) }
}

async function collectStagedDataFiles(
  stagingRoot: string,
  skippedFileDetails: VastBackupSkippedFile[],
  hooks?: VastBackupFileOperationHooksForTests
): Promise<CollectedStagedFiles> {
  const root = resolve(stagingRoot)
  const files: ZipEntryInput[] = []
  const includedFiles: string[] = []
  const checksums: Record<string, VastBackupChecksum> = {}

  async function visit(relativeRoot = ''): Promise<void> {
    const directory = relativeRoot ? join(root, relativeRoot) : root
    let entries: string[]
    try {
      entries = await withFileRetries(() => readdir(directory))
    } catch (error) {
      addSkippedFile(skippedFileDetails, normalizeArchivePath(relativeRoot || '.'), fileFailureReason('Read staged directory', error))
      return
    }

    for (const entry of entries) {
      const relativePath = relativeRoot ? join(relativeRoot, entry) : entry
      const normalized = normalizeArchivePath(relativePath)
      const absolute = join(root, relativePath)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await withFileRetries(() => lstat(absolute))
      } catch (error) {
        if (isCriticalVastData(normalized)) throw new Error(criticalVastDataUnavailableMessage)
        addSkippedFile(skippedFileDetails, normalized, fileFailureReason('Inspect staged file', error))
        continue
      }
      if (info.isDirectory()) {
        await visit(relativePath)
        continue
      }
      if (!info.isFile()) continue
      if (info.size > maxEntryBytes) {
        if (isCriticalVastData(normalized)) throw new Error(criticalVastDataUnavailableMessage)
        addSkippedFile(skippedFileDetails, normalized, `File is larger than the ${maxEntryBytes} byte backup entry limit.`)
        continue
      }

      let data: Buffer
      try {
        data = await withFileRetries(
          () => readFile(absolute),
          (attempt) => hooks?.beforeRead?.(normalized, attempt)
        )
      } catch (error) {
        if (isCriticalVastData(normalized)) throw new Error(criticalVastDataUnavailableMessage)
        addSkippedFile(skippedFileDetails, normalized, fileFailureReason('Read staged file', error))
        continue
      }

      const archivePath = `data/${normalized}`
      files.push({ path: archivePath, data })
      includedFiles.push(normalized)
      checksums[archivePath] = {
        sha256: createHash('sha256').update(data).digest('hex'),
        sizeBytes: data.length
      }
    }
  }

  await visit()
  includedFiles.sort()
  return { files, includedFiles, checksums }
}

function backupReadme(manifest: VastBackupManifest): string {
  return [
    'Vast Backup',
    '',
    `Created: ${manifest.createdAt}`,
    `App version: ${manifest.appVersion}`,
    `Included files: ${manifest.includedFileCount}`,
    `Skipped files: ${manifest.skippedFileCount}`,
    `vast-data.json included: ${manifest.vastDataIncluded ? 'yes' : 'no'}`,
    `password-vault.json included: ${manifest.passwordVaultIncluded ? 'yes' : 'no'}`,
    '',
    'This archive contains Vast-owned local profile data. Password vault and website session data can be machine-bound by the operating system and may not transfer to another computer or OS account.',
    '',
    'Included sections:',
    ...manifest.includedSections.map((section) => `- ${section}`),
    '',
    'Skipped files:',
    ...(manifest.skippedFiles.length > 0
      ? manifest.skippedFiles.map((item) => `- ${item.path}: ${item.reason}`)
      : ['- None']),
    '',
    'Warnings:',
    ...manifest.warnings.map((warning) => `- ${warning}`),
    ''
  ].join('\n')
}

function shouldWarnForSkippedFile(item: VastBackupSkippedFile): boolean {
  return !item.reason.startsWith('Volatile browser/cache data is skipped.')
    && !item.reason.startsWith('Existing backup archives are skipped.')
    && !item.reason.startsWith('Updater profile backups are skipped')
}

function defaultWarnings(includedFiles: string[], skippedFiles: VastBackupSkippedFile[]): string[] {
  const warnings = [
    'Website cookies and Chromium session storage may not transfer perfectly across computers or OS accounts.'
  ]
  if (includedFiles.includes('password-vault.json')) {
    warnings.push('The password vault is OS-encrypted and may only decrypt on the same OS account unless the matching browser encryption state is portable.')
  } else if (skippedFiles.some((item) => item.path === 'password-vault.json')) {
    warnings.push('password-vault.json could not be included because it was locked or unavailable; saved website passwords may not migrate.')
  }
  const actionableSkipped = skippedFiles.filter(shouldWarnForSkippedFile)
  if (actionableSkipped.length > 0) {
    warnings.push(`${actionableSkipped.length} non-critical profile file${actionableSkipped.length === 1 ? '' : 's'} were skipped because they were locked, unavailable, or not safe to export.`)
  }
  return warnings
}

export function validateBackupManifest(manifest: unknown): { ok: true } | { ok: false; error: string } {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'Backup manifest is missing.' }
  const value = manifest as Partial<VastBackupManifest>
  if (value.product !== 'Vast') return { ok: false, error: 'Backup is not a Vast backup.' }
  if (value.exportFormatVersion !== VAST_BACKUP_FORMAT_VERSION) return { ok: false, error: 'Unsupported Vast backup format.' }
  if (!Array.isArray(value.includedSections) || !value.checksums || typeof value.checksums !== 'object') {
    return { ok: false, error: 'Backup manifest is incomplete.' }
  }
  const checksums = value.checksums as Record<string, VastBackupChecksum>
  const paths = Object.keys(checksums)
  if (!Number.isInteger(value.includedFileCount) || value.includedFileCount !== paths.length) {
    return { ok: false, error: 'Backup manifest file count does not match its checksums.' }
  }
  if (value.vastDataIncluded !== true || !checksums['data/vast-data.json']) {
    return { ok: false, error: 'Backup does not contain the required Vast data file.' }
  }
  const passwordVaultIncluded = Boolean(checksums['data/password-vault.json'])
  if (value.passwordVaultIncluded !== passwordVaultIncluded) {
    return { ok: false, error: 'Backup password vault metadata does not match its files.' }
  }
  if (passwordVaultIncluded && !checksums['data/Local State']) {
    return { ok: false, error: 'Backup contains a password vault without its matching Local State encryption key.' }
  }
  for (const [path, checksum] of Object.entries(checksums)) {
    if (!path.startsWith('data/') || path === 'data/' || !checksum || typeof checksum !== 'object') {
      return { ok: false, error: `Backup manifest has an invalid checksum path: ${path}` }
    }
    if (!/^[a-f0-9]{64}$/i.test(checksum.sha256) || !Number.isInteger(checksum.sizeBytes) || checksum.sizeBytes < 0 || checksum.sizeBytes > maxEntryBytes) {
      return { ok: false, error: `Backup manifest has an invalid checksum: ${path}` }
    }
  }
  return { ok: true }
}

export async function createVastBackupArchive(options: CreateVastBackupOptions): Promise<CreateVastBackupReport> {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'vast-backup-stage-'))
  try {
    const staged = await stageDataRootForBackup(options.dataRoot, stagingRoot, options.fileOperationHooksForTests)
    const skippedFileDetails = [...staged.skippedFileDetails]
    const collected = await collectStagedDataFiles(stagingRoot, skippedFileDetails, options.fileOperationHooksForTests)
    const sortedSkippedFileDetails = sortedSkippedFiles(skippedFileDetails)
    const skippedFiles = skippedFilePaths(sortedSkippedFileDetails)
    const includedSections = [...new Set(collected.includedFiles.map(sectionForPath))].sort()
    const excludedSections = [
      ...(sortedSkippedFileDetails.some((item) => item.reason.startsWith('Volatile browser/cache data is skipped.'))
        ? ['Volatile browser caches and updater scratch files']
        : []),
      ...(sortedSkippedFileDetails.some((item) => item.reason.startsWith('Updater profile backups are skipped'))
        ? ['Redundant updater profile backups']
        : []),
      ...(sortedSkippedFileDetails.some(shouldWarnForSkippedFile) ? ['Skipped locked, unavailable, or unsafe non-critical files'] : [])
    ]
    const vastDataIncluded = collected.includedFiles.includes('vast-data.json')
    if (!vastDataIncluded) throw new Error(criticalVastDataUnavailableMessage)
    const passwordVaultIncluded = collected.includedFiles.includes('password-vault.json')
    if (passwordVaultIncluded && !collected.includedFiles.includes('Local State')) {
      throw new Error(passwordVaultKeyUnavailableMessage)
    }
    const manifest: VastBackupManifest = {
      product: 'Vast',
      appId: options.appId,
      exportFormatVersion: VAST_BACKUP_FORMAT_VERSION,
      appVersion: options.appVersion,
      platform: options.platform,
      createdAt: new Date().toISOString(),
      includedSections,
      excludedSections,
      includedFileCount: collected.includedFiles.length,
      skippedFileCount: skippedFiles.length,
      skippedFiles: sortedSkippedFileDetails,
      vastDataIncluded,
      passwordVaultIncluded,
      checksums: collected.checksums,
      warnings: defaultWarnings(collected.includedFiles, sortedSkippedFileDetails)
    }
    options.manifestTransformForTests?.(manifest)
    const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    let entries: ZipEntryInput[] = [
      { path: 'manifest.json', data: manifestData },
      { path: 'README.md', data: Buffer.from(backupReadme(manifest), 'utf8') },
      ...collected.files
    ]
    for (const entry of options.extraEntriesForTests ?? []) {
      entries.push({ path: entry.path, data: typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data })
    }
    const omitted = new Set(options.omitArchiveEntriesForTests ?? [])
    entries = entries
      .filter((entry) => !omitted.has(entry.path))
      .map((entry) => {
        const override = options.archiveEntryOverridesForTests?.[entry.path]
        return override === undefined
          ? entry
          : { path: entry.path, data: typeof override === 'string' ? Buffer.from(override, 'utf8') : override }
      })

    if (entries.length > maxArchiveEntries) {
      throw new Error(`Vast profile contains too many files to create an importable backup (maximum ${maxArchiveEntries}).`)
    }
    const totalUncompressedBytes = entries.reduce((total, entry) => total + entry.data.length, 0)
    if (totalUncompressedBytes > maxTotalUncompressedBytes) {
      throw new Error('Vast profile expands beyond the maximum importable backup size.')
    }

    const archive = zipEntries(entries)
    if (archive.length > maxArchiveBytes) {
      throw new Error('Vast profile produces a backup archive larger than the import limit.')
    }
    await mkdir(dirname(options.destinationPath), { recursive: true })
    const tempPath = `${options.destinationPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tempPath, archive)
    await rename(tempPath, options.destinationPath)
    return {
      ok: true,
      path: options.destinationPath,
      includedFiles: collected.includedFiles,
      skippedFiles,
      includedFileCount: collected.includedFiles.length,
      skippedFileCount: skippedFiles.length,
      skippedFileDetails: sortedSkippedFileDetails,
      vastDataIncluded,
      passwordVaultIncluded,
      manifest
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

function assertSafeArchivePath(destinationRoot: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Unsafe archive entry: ${entryPath}`)
  }
  const destination = resolve(destinationRoot, normalized)
  const root = resolve(destinationRoot)
  const rel = relative(root, destination)
  if (!rel || rel.startsWith('..')) throw new Error(`Unsafe archive entry: ${entryPath}`)
  return destination
}

export async function listZipEntries(archivePath: string): Promise<string[]> {
  const archive = await readArchiveWithinLimit(archivePath)
  return parseZipEntryRecords(archive).map((entry) => entry.path).sort()
}

export async function extractVastBackupArchive(
  archivePath: string,
  destinationRoot: string,
  options: ExtractVastBackupOptions = {}
): Promise<{ manifest: VastBackupManifest; extractedFiles: string[] }> {
  const archive = await readArchiveWithinLimit(archivePath)
  const entries = parseZipEntryRecords(archive)
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]))
  const manifestEntry = entryByPath.get('manifest.json')
  if (!manifestEntry) throw new Error('Vast backup manifest is missing.')
  const manifest = JSON.parse(inflateZipEntry(manifestEntry).toString('utf8')) as VastBackupManifest
  const validation = validateBackupManifest(manifest)
  if (!validation.ok) throw new Error(validation.error)

  const expectedDataPaths = new Set(Object.keys(manifest.checksums))
  const permittedPaths = new Set(['manifest.json', 'README.md', ...expectedDataPaths])
  for (const entry of entries) {
    assertSafeArchivePath(destinationRoot, entry.path)
    if (!permittedPaths.has(entry.path)) throw new Error(`Unexpected file in Vast backup: ${entry.path}`)
  }
  for (const path of expectedDataPaths) {
    if (!entryByPath.has(path)) throw new Error(`Vast backup is missing expected file: ${path}`)
  }

  const staging = await mkdtemp(join(tmpdir(), 'vast-backup-extract-'))
  let previousDestination: string | undefined
  try {
    const extractedFiles: string[] = []
    for (const entry of entries) {
      const destination = assertSafeArchivePath(staging, entry.path)
      const data = inflateZipEntry(entry)
      const expectedChecksum = manifest.checksums[entry.path]
      if (expectedChecksum) {
        if (data.length !== expectedChecksum.sizeBytes) throw new Error(`Vast backup size mismatch: ${entry.path}`)
        const actualChecksum = createHash('sha256').update(data).digest('hex')
        if (actualChecksum.toLowerCase() !== expectedChecksum.sha256.toLowerCase()) {
          throw new Error(`Vast backup checksum mismatch: ${entry.path}`)
        }
      }
      if (entry.path === 'data/vast-data.json') {
        const parsed = JSON.parse(data.toString('utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Imported Vast data is invalid.')
      }
      if (isLegacyProductMetadataPath(entry.path)) continue
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, data)
      extractedFiles.push(entry.path)
    }
    await options.beforeActivateForTests?.()
    await mkdir(dirname(destinationRoot), { recursive: true })
    const destinationExists = await stat(destinationRoot).then(() => true).catch(() => false)
    if (destinationExists) {
      previousDestination = `${destinationRoot}.previous-${process.pid}-${Date.now()}`
      await rename(destinationRoot, previousDestination)
    }
    await rename(staging, destinationRoot)
    if (previousDestination) await rm(previousDestination, { recursive: true, force: true })
    return { manifest, extractedFiles: extractedFiles.sort() }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if (previousDestination) {
      const destinationExists = await stat(destinationRoot).then(() => true).catch(() => false)
      if (!destinationExists) await rename(previousDestination, destinationRoot).catch(() => undefined)
    }
    throw error
  }
}
