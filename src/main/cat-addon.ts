import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { inflateRaw } from 'node:zlib'
import type { CatAddonState } from '../shared/types'
import { parseCatAnimationMetadata, type CatAddonRuntimeBundle, type CatAnimationMetadata } from '../shared/cat-addon-runtime.ts'

const ADDON_ID = 'com.vast.cat-addon'
const ADDON_API_VERSION = 2
const MAX_ARCHIVE_BYTES = 1024 * 1024
const MAX_ENTRY_BYTES = 512 * 1024
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 8
const ALLOWED_EXTENSIONS = new Set(['.json', '.png'])

interface ParsedZipEntry {
  path: string
  data: Buffer
}

interface CatAddonAssetManifest {
  path: string
  role: 'runtime-atlas'
  mime_type: 'image/png'
  width: number
  height: number
  frame_width: number
  frame_height: number
  frames: number
  size: number
  sha256: string
}

interface CatAddonManifest {
  id: string
  name: string
  version: string
  api_version: number
  minimum_vast_version: string
  canonical_character: 'Cat_Grey_White'
  license_status: 'unverified-release-blocker'
  animations: { path: string; size: number; sha256: string }
  assets: CatAddonAssetManifest[]
}

export interface CatAddonManagerOptions {
  archivePath: string
  userDataRoot: string
  expectedArchiveHash: string
  bundledVersion: string
  vastVersion: string
  onStateChanged?: (state: CatAddonState) => void
  beforeActivateForTests?: () => void | Promise<void>
  beforeRemoveForTests?: () => void | Promise<void>
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 320)
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('Cat Addon archive has no valid central directory.')
}

function safeArchivePath(path: string): string {
  if (
    !path || path.length > 180 || path.includes('\\') || path.includes('\0') || /[\x00-\x1f\x7f]/.test(path) ||
    path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes(':')
  ) {
    throw new Error(`Unsafe Cat Addon archive path: ${path || '[empty]'}`)
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe Cat Addon archive path: ${path}`)
  }
  const dot = path.lastIndexOf('.')
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : ''
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Unsupported Cat Addon file type: ${path}`)
  return segments.join('/')
}

function fileTypeFromExternalAttributes(versionMadeBy: number, attributes: number): number {
  const hostSystem = versionMadeBy >>> 8
  if (hostSystem !== 3) return 0
  return (attributes >>> 16) & 0o170000
}

function inflateArchiveEntry(compressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(compressed, { maxOutputLength: MAX_ENTRY_BYTES }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

export async function parseCatAddonArchive(buffer: Buffer): Promise<ParsedZipEntry[]> {
  if (buffer.length === 0 || buffer.length > MAX_ARCHIVE_BYTES) throw new Error('Cat Addon archive is too large or empty.')
  const end = findEndOfCentralDirectory(buffer)
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) {
    throw new Error('Multi-disk Cat Addon archives are not supported.')
  }
  const diskCount = buffer.readUInt16LE(end + 8)
  const count = buffer.readUInt16LE(end + 10)
  if (count !== diskCount || count === 0 || count > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Cat Addon archive contains an invalid number of entries.')
  }
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralOffset = buffer.readUInt32LE(end + 16)
  if (centralOffset + centralSize !== end || centralOffset >= end) throw new Error('Cat Addon central directory bounds are invalid.')

  const entries: ParsedZipEntry[] = []
  const normalizedPaths = new Set<string>()
  let extractedBytes = 0
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Cat Addon central directory is malformed.')
    const versionMadeBy = buffer.readUInt16LE(cursor + 4)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const diskStart = buffer.readUInt16LE(cursor + 34)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength
    if (nextCursor > end || nameLength === 0) throw new Error('Cat Addon entry bounds are invalid.')
    if (diskStart !== 0 || flags !== 0x0800 || (method !== 0 && method !== 8)) throw new Error('Cat Addon archive uses unsupported ZIP features.')
    const fileType = fileTypeFromExternalAttributes(versionMadeBy, externalAttributes)
    if (fileType !== 0 && fileType !== 0o100000) throw new Error('Cat Addon archive links and special files are forbidden.')
    if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) throw new Error('Cat Addon archive entry exceeds its size limit.')
    extractedBytes += uncompressedSize
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('Cat Addon archive expands beyond its total size limit.')

    const centralName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const path = safeArchivePath(centralName)
    const collisionKey = path.toLowerCase()
    if (normalizedPaths.has(collisionKey)) throw new Error(`Duplicate Cat Addon archive path: ${path}`)
    normalizedPaths.add(collisionKey)

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Cat Addon local entry is malformed.')
    const localFlags = buffer.readUInt16LE(localOffset + 6)
    const localMethod = buffer.readUInt16LE(localOffset + 8)
    const localCrc = buffer.readUInt32LE(localOffset + 14)
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18)
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const localNameStart = localOffset + 30
    const dataStart = localNameStart + localNameLength + localExtraLength
    if (dataStart + compressedSize > centralOffset) throw new Error('Cat Addon compressed data bounds are invalid.')
    const localName = buffer.subarray(localNameStart, localNameStart + localNameLength).toString('utf8')
    if (
      localName !== centralName || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize
    ) throw new Error('Cat Addon local and central entries disagree.')
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(compressed) : await inflateArchiveEntry(compressed)
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw new Error(`Cat Addon entry failed CRC or size validation: ${path}`)
    entries.push({ path, data })
    cursor = nextCursor
  }
  if (cursor !== end) throw new Error('Cat Addon central directory contains trailing records.')
  return entries
}

function semanticVersion(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionAtLeast(current: string, minimum: string): boolean {
  const currentParts = semanticVersion(current)
  const minimumParts = semanticVersion(minimum)
  if (!currentParts || !minimumParts) return false
  for (let index = 0; index < 3; index += 1) {
    if (currentParts[index] !== minimumParts[index]) return currentParts[index] > minimumParts[index]
  }
  return true
}

function pngMetadata(data: Buffer): { width: number; height: number; frames: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (data.length < 33 || !data.subarray(0, 8).equals(signature) || data.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Cat Addon PNG asset is invalid.')
  }
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  let frames = 1
  let offset = 8
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('ascii')
    if (offset + 12 + length > data.length) throw new Error('Cat Addon PNG chunks are invalid.')
    if (type === 'acTL') frames = data.readUInt32BE(offset + 8)
    offset += 12 + length
    if (type === 'IEND') break
  }
  return { width, height, frames }
}

function validatedAsset(value: unknown): CatAddonAssetManifest {
  if (!isRecord(value)) throw new Error('Cat Addon manifest contains an invalid asset.')
  if (value.role !== 'runtime-atlas' || value.mime_type !== 'image/png') throw new Error('Cat Addon asset identity is invalid.')
  const path = safeArchivePath(typeof value.path === 'string' ? value.path : '')
  if (path !== 'assets/cat_grey_white.png') throw new Error('Cat Addon runtime atlas path is invalid.')
  const numbers = ['width', 'height', 'frame_width', 'frame_height', 'frames', 'size'] as const
  for (const key of numbers) if (!Number.isInteger(value[key]) || Number(value[key]) < 1) throw new Error(`Cat Addon asset ${key} is invalid.`)
  if (
    Number(value.width) > 2048 || Number(value.height) > 2048 || value.frame_width !== 32 || value.frame_height !== 32 ||
    Number(value.width) % 32 !== 0 || Number(value.height) % 32 !== 0 || Number(value.frames) > Number(value.width) / 32 * (Number(value.height) / 32) ||
    Number(value.frames) > 512 || Number(value.size) > MAX_ENTRY_BYTES
  ) throw new Error('Cat Addon runtime atlas metadata exceeds its limits.')
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Cat Addon asset hash is invalid.')
  return value as unknown as CatAddonAssetManifest
}

export function validateCatAddonPackage(entries: ParsedZipEntry[], vastVersion: string, expectedVersion: string): CatAddonManifest {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const manifestEntry = byPath.get('manifest.json')
  if (!manifestEntry || manifestEntry.data.length > 64 * 1024) throw new Error('Cat Addon manifest is missing or too large.')
  let rawManifest: unknown
  try { rawManifest = JSON.parse(manifestEntry.data.toString('utf8')) } catch { throw new Error('Cat Addon manifest JSON is invalid.') }
  if (!isRecord(rawManifest)) throw new Error('Cat Addon manifest must be an object.')
  if (rawManifest.id !== ADDON_ID || rawManifest.name !== 'Cat Addon') throw new Error('Cat Addon manifest identity is invalid.')
  if (rawManifest.api_version !== ADDON_API_VERSION) throw new Error('Cat Addon API version is unsupported.')
  if (rawManifest.version !== expectedVersion || !semanticVersion(rawManifest.version)) throw new Error('Cat Addon bundle version is invalid.')
  if (typeof rawManifest.minimum_vast_version !== 'string' || !versionAtLeast(vastVersion, rawManifest.minimum_vast_version)) throw new Error('This Cat Addon bundle requires a newer Vast version.')
  if (rawManifest.canonical_character !== 'Cat_Grey_White' || rawManifest.license_status !== 'unverified-release-blocker') {
    throw new Error('Cat Addon canonical character or provenance status is invalid.')
  }
  if (!isRecord(rawManifest.animations)) throw new Error('Cat Addon animation descriptor is invalid.')
  const animationsPath = safeArchivePath(typeof rawManifest.animations.path === 'string' ? rawManifest.animations.path : '')
  if (!animationsPath.endsWith('.json')) throw new Error('Cat Addon animation manifest must be JSON.')
  if (
    !Number.isInteger(rawManifest.animations.size) || Number(rawManifest.animations.size) < 1 || Number(rawManifest.animations.size) > MAX_ENTRY_BYTES ||
    typeof rawManifest.animations.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rawManifest.animations.sha256)
  ) throw new Error('Cat Addon animation descriptor integrity is invalid.')
  if (!Array.isArray(rawManifest.assets) || rawManifest.assets.length !== 1) throw new Error('Cat Addon manifest asset list is invalid.')
  const assets = rawManifest.assets.map(validatedAsset)
  const permitted = new Set(['manifest.json', animationsPath, ...assets.map((asset) => asset.path)])
  if (entries.some((entry) => !permitted.has(entry.path)) || [...permitted].some((path) => !byPath.has(path))) throw new Error('Cat Addon archive has missing or undeclared files.')

  for (const asset of assets) {
    const data = byPath.get(asset.path)!.data
    if (data.length !== asset.size || sha256(data) !== asset.sha256) throw new Error(`Cat Addon asset integrity failed: ${asset.path}`)
    const metadata = pngMetadata(data)
    if (metadata.width !== asset.width || metadata.height !== asset.height || metadata.frames !== 1) throw new Error(`Cat Addon asset metadata failed: ${asset.path}`)
  }

  const animationsEntry = byPath.get(animationsPath)!
  if (
    animationsEntry.data.length !== rawManifest.animations.size ||
    sha256(animationsEntry.data) !== rawManifest.animations.sha256
  ) throw new Error('Cat Addon animation metadata integrity failed.')
  let animations: unknown
  try { animations = JSON.parse(animationsEntry.data.toString('utf8')) } catch { throw new Error('Cat Addon animation JSON is invalid.') }
  const parsedAnimations = parseCatAnimationMetadata(animations)
  const atlas = assets[0]
  if (
    parsedAnimations.atlas.path !== atlas.path || parsedAnimations.atlas.width !== atlas.width ||
    parsedAnimations.atlas.height !== atlas.height || parsedAnimations.atlas.frame_width !== atlas.frame_width ||
    parsedAnimations.atlas.frame_height !== atlas.frame_height || parsedAnimations.atlas.frames !== atlas.frames
  ) throw new Error('Cat Addon atlas and animation metadata disagree.')
  return {
    ...(rawManifest as unknown as CatAddonManifest),
    animations: { path: animationsPath, size: Number(rawManifest.animations.size), sha256: rawManifest.animations.sha256 as string },
    assets
  }
}

function cloneState(state: CatAddonState): CatAddonState {
  return { ...state }
}

export class CatAddonManager {
  private readonly options: CatAddonManagerOptions
  private readonly addonRoot: string
  private readonly finalRoot: string
  private readonly pendingCleanupPath: string
  private state: CatAddonState = { enabled: false, installed: false, phase: 'disabled' }
  private desiredEnabled = false
  private revision = 0
  private operation: Promise<void> | undefined
  private runtimeBundle: CatAddonRuntimeBundle | undefined

  constructor(options: CatAddonManagerOptions) {
    this.options = options
    this.addonRoot = join(options.userDataRoot, 'CatAddon')
    this.finalRoot = join(this.addonRoot, options.bundledVersion)
    this.pendingCleanupPath = join(this.addonRoot, 'pending-cleanup.json')
  }

  getState(): CatAddonState {
    return cloneState(this.state)
  }

  initialize(enabled: boolean): Promise<CatAddonState> {
    return this.setEnabled(enabled)
  }

  enable(): Promise<CatAddonState> {
    return this.setEnabled(true)
  }

  disable(): Promise<CatAddonState> {
    return this.setEnabled(false)
  }

  async runtime(): Promise<CatAddonRuntimeBundle> {
    if (!this.state.enabled || !this.state.installed || !this.desiredEnabled) throw new Error('Cat Addon is not enabled.')
    if (this.runtimeBundle) return this.runtimeBundle
    await this.validateInstalled()
    if (!this.state.enabled || !this.desiredEnabled) throw new Error('Cat Addon was disabled while loading its runtime.')
    const [atlas, metadataData] = await Promise.all([
      readFile(resolve(this.finalRoot, 'assets', 'cat_grey_white.png')),
      readFile(resolve(this.finalRoot, 'animations', 'animations.json'))
    ])
    if (!this.state.enabled || !this.desiredEnabled) throw new Error('Cat Addon was disabled while loading its runtime.')
    const metadata = parseCatAnimationMetadata(JSON.parse(metadataData.toString('utf8'))) as CatAnimationMetadata
    this.runtimeBundle = { atlasDataUrl: `data:image/png;base64,${atlas.toString('base64')}`, metadata }
    return this.runtimeBundle
  }

  private setState(next: CatAddonState): void {
    this.state = cloneState(next)
    this.options.onStateChanged?.(this.getState())
  }

  private setEnabled(enabled: boolean): Promise<CatAddonState> {
    this.desiredEnabled = enabled
    this.revision += 1
    if (!enabled) {
      this.runtimeBundle = undefined
      this.setState({ ...this.state, enabled: false, phase: this.state.installed ? 'disabling' : 'disabled', error: undefined })
    } else if (!this.state.enabled) {
      this.setState({ ...this.state, enabled: false, phase: 'enabling', error: undefined })
    }
    if (!this.operation) {
      this.operation = this.reconcileLoop().finally(() => { this.operation = undefined })
    }
    return this.operation.then(() => this.getState())
  }

  private async reconcileLoop(): Promise<void> {
    let observedRevision = -1
    while (observedRevision !== this.revision) {
      observedRevision = this.revision
      try {
        if (this.desiredEnabled) await this.ensureEnabled()
        else await this.ensureDisabled()
      } catch (error) {
        const message = safeError(error)
        this.desiredEnabled = false
        this.setState({ enabled: false, installed: false, phase: 'error', error: message })
        console.warn(`[cat-addon] Operation failed: ${message}`)
        break
      }
    }
  }

  private async archiveEntries(): Promise<ParsedZipEntry[]> {
    const info = await stat(this.options.archivePath)
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES) throw new Error('Bundled Cat Addon archive is missing or invalid.')
    const archive = await readFile(this.options.archivePath)
    if (sha256(archive) !== this.options.expectedArchiveHash) throw new Error('Bundled Cat Addon archive integrity check failed.')
    console.info('[cat-addon] Bundled archive integrity verified.')
    const entries = await parseCatAddonArchive(archive)
    validateCatAddonPackage(entries, this.options.vastVersion, this.options.bundledVersion)
    return entries
  }

  private directChild(path: string): string {
    const root = resolve(this.addonRoot)
    const target = resolve(path)
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) throw new Error('Refusing Cat Addon file operation outside its root.')
    return target
  }

  private async removeChild(path: string): Promise<void> {
    const target = this.directChild(path)
    const info = await lstat(target).catch(() => undefined)
    if (!info) return
    if (info.isSymbolicLink()) await unlink(target)
    else if (info.isDirectory()) await rm(target, { recursive: true, force: true })
    else await rm(target, { force: true })
  }

  private async cleanupStaleDirectories(): Promise<void> {
    await mkdir(this.addonRoot, { recursive: true })
    const entries = await readdir(this.addonRoot, { withFileTypes: true })
    for (const entry of entries) {
      const oldBundle = Boolean(semanticVersion(entry.name)) && entry.name !== this.options.bundledVersion
      if (!entry.name.startsWith('.install-') && !entry.name.startsWith('.previous-') && !oldBundle) continue
      await this.removeChild(join(this.addonRoot, entry.name))
    }
    await rm(this.pendingCleanupPath, { force: true }).catch(() => undefined)
  }

  private async validateInstalled(): Promise<CatAddonManifest> {
    const rootInfo = await lstat(this.finalRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Installed Cat Addon directory is unsafe.')
    const paths = ['manifest.json', 'animations/animations.json', 'assets/cat_grey_white.png']
    const entries: ParsedZipEntry[] = []
    for (const path of paths) {
      const destination = resolve(this.finalRoot, ...path.split('/'))
      const rel = relative(resolve(this.finalRoot), destination)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Installed Cat Addon path escaped its root.')
      const info = await lstat(destination)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENTRY_BYTES) throw new Error(`Installed Cat Addon file is unsafe: ${path}`)
      entries.push({ path, data: await readFile(destination) })
    }
    return validateCatAddonPackage(entries, this.options.vastVersion, this.options.bundledVersion)
  }

  private async install(entries: ParsedZipEntry[]): Promise<void> {
    await mkdir(this.addonRoot, { recursive: true })
    const staging = this.directChild(join(this.addonRoot, `.install-${randomUUID()}`))
    const previous = this.directChild(join(this.addonRoot, `.previous-${randomUUID()}`))
    let previousActive = false
    await mkdir(staging)
    try {
      for (const entry of entries) {
        const destination = resolve(staging, ...entry.path.split('/'))
        const rel = relative(staging, destination)
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Cat Addon extraction escaped staging.')
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, entry.data, { mode: 0o600 })
      }
      const stagedEntries = await Promise.all(entries.map(async (entry) => ({
        path: entry.path,
        data: await readFile(resolve(staging, ...entry.path.split('/')))
      })))
      validateCatAddonPackage(stagedEntries, this.options.vastVersion, this.options.bundledVersion)
      await this.options.beforeActivateForTests?.()
      if (!this.desiredEnabled) return
      const currentInfo = await lstat(this.finalRoot).catch(() => undefined)
      if (currentInfo) {
        if (currentInfo.isSymbolicLink()) throw new Error('Installed Cat Addon path is a link.')
        await rename(this.finalRoot, previous)
        previousActive = true
      }
      await rename(staging, this.finalRoot)
      if (previousActive) await this.removeChild(previous)
      console.info('[cat-addon] Bundle extracted and activated atomically.')
    } catch (error) {
      await this.removeChild(staging).catch(() => undefined)
      if (previousActive) {
        const finalExists = await lstat(this.finalRoot).then(() => true).catch(() => false)
        if (!finalExists) await rename(previous, this.finalRoot).catch(() => undefined)
      }
      throw error
    } finally {
      await this.removeChild(staging).catch(() => undefined)
    }
  }

  private async ensureEnabled(): Promise<void> {
    this.runtimeBundle = undefined
    this.setState({ ...this.state, enabled: false, phase: 'enabling', error: undefined })
    await this.cleanupStaleDirectories()
    let manifest: CatAddonManifest | undefined
    try { manifest = await this.validateInstalled() } catch { manifest = undefined }
    if (!manifest) {
      const entries = await this.archiveEntries()
      if (!this.desiredEnabled) return
      await this.removeChild(this.finalRoot).catch(() => undefined)
      await this.install(entries)
      if (!this.desiredEnabled) return
      manifest = await this.validateInstalled()
    }
    if (!this.desiredEnabled) return
    this.setState({
      enabled: true,
      installed: true,
      phase: 'enabled',
      version: manifest.version
    })
    console.info(`[cat-addon] Activated bundle version ${manifest.version}.`)
  }

  private async ensureDisabled(): Promise<void> {
    this.runtimeBundle = undefined
    this.setState({ ...this.state, enabled: false, phase: this.state.installed ? 'disabling' : 'disabled', error: undefined })
    try {
      await this.options.beforeRemoveForTests?.()
      await mkdir(this.addonRoot, { recursive: true })
      const children = await readdir(this.addonRoot, { withFileTypes: true })
      for (const child of children) {
        if (child.name === 'pending-cleanup.json') continue
        await this.removeChild(join(this.addonRoot, child.name))
      }
      await rm(this.pendingCleanupPath, { force: true })
      this.setState({ enabled: false, installed: false, phase: 'disabled' })
      console.info('[cat-addon] Runtime disabled and extracted files removed.')
    } catch (error) {
      const message = safeError(error)
      await mkdir(this.addonRoot, { recursive: true }).catch(() => undefined)
      await writeFile(this.pendingCleanupPath, JSON.stringify({ pending: true }), { mode: 0o600 }).catch(() => undefined)
      this.setState({ enabled: false, installed: true, phase: 'disabled', error: `Cleanup will retry on next launch. ${message}` })
    }
  }
}
