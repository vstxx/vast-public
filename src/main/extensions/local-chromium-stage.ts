import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_FILES = 10_000
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_DEPTH = 16
const MAX_DURATION_MS = 30_000
const PRIVATE_PATH_PARTS = new Set([
  'local extension settings', 'sync extension settings', 'extension state',
  'indexeddb', 'local storage', 'session storage', 'cookies', 'network'
])
const EXTENSION_ID = /^[a-p]{32}$/
const VERSION = /^[0-9]+(?:\.[0-9]+){0,3}$/

export interface LocalChromiumStage {
  root: string
  contentRoot: string
  sourceExtensionId: string
  version: string
  fingerprint: string
  manifestSha256: string
  fileCount: number
  byteCount: number
}

interface FileRecord { relativePath: string; absolutePath: string; size: number; sha256: string }

function inside(root: string, candidate: string): boolean {
  const next = relative(root, candidate)
  return next === '' || (next !== '..' && !next.startsWith(`..${sep}`) && !isAbsolute(next))
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function fingerprint(records: FileRecord[]): string {
  const digest = createHash('sha256')
  for (const record of records) digest.update(record.relativePath).update('\0').update(String(record.size)).update('\0').update(record.sha256).update('\0')
  return digest.digest('hex')
}

function check(signal: AbortSignal, deadline: number): void {
  if (signal.aborted) throw new Error('Extension staging was cancelled.')
  if (Date.now() > deadline) throw new Error('Extension staging timed out.')
}

async function sourceBytes(root: string, path: string, maxBytes: number): Promise<Uint8Array> {
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) throw new Error('Extension contains an unsafe or oversized file.')
  if (!inside(root, await realpath(path))) throw new Error('Extension file escapes its source root.')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.byteLength ||
      after.mtimeMs !== entry.mtimeMs || after.ino !== entry.ino || !inside(root, await realpath(path))) {
    throw new Error('Extension source changed during staging.')
  }
  return bytes
}

async function inventory(root: string, signal: AbortSignal, deadline: number, omitSourceMetadata = false): Promise<FileRecord[]> {
  const files: FileRecord[] = []
  const folded = new Set<string>()
  let total = 0
  const visit = async (dir: string, parts: string[]): Promise<void> => {
    check(signal, deadline)
    if (parts.length > MAX_DEPTH) throw new Error('Extension directory depth exceeds its limit.')
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      check(signal, deadline)
      // Chrome/Edge install metadata is browser-owned, not extension code.
      // Electron's unpacked loader deletes this directory on load; excluding
      // it keeps our immutable managed copy and its fingerprint stable.
      if (parts.length === 0 && entry.name.toLowerCase() === '_metadata') {
        if (omitSourceMetadata) continue
        throw new Error('Managed extension contains browser-owned metadata.')
      }
      if (entry.name === '.' || entry.name === '..' || PRIVATE_PATH_PARTS.has(entry.name.toLowerCase())) {
        throw new Error('Extension contains a private or invalid path.')
      }
      const nextParts = [...parts, entry.name]
      const relativePath = nextParts.join('/')
      const key = relativePath.toLowerCase()
      if (folded.has(key)) throw new Error('Extension contains case-insensitive path collisions.')
      folded.add(key)
      const path = join(dir, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink() || !inside(root, await realpath(path))) throw new Error('Extension contains a link or escaping path.')
      if (info.isDirectory()) {
        if (nextParts.length >= MAX_DEPTH) throw new Error('Extension directory depth exceeds its limit.')
        await visit(path, nextParts)
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) throw new Error('Extension file exceeds its limit.')
        total += info.size
        if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) throw new Error('Extension content exceeds its limit.')
        const bytes = await sourceBytes(root, path, MAX_FILE_BYTES)
        files.push({ relativePath, absolutePath: path, size: bytes.byteLength, sha256: sha256(bytes) })
      } else throw new Error('Extension contains a non-regular file.')
    }
  }
  await visit(root, [])
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  if (!files.some((file) => file.relativePath === 'manifest.json')) throw new Error('Extension manifest is missing.')
  return files
}

/** Stages only the installed extension version directory, never Chromium private storage. */
export async function stageLocalChromiumDirectory(input: {
  sourceRoot: string
  sourceExtensionId: string
  expectedVersion: string
  stagingRoot: string
}, signal: AbortSignal): Promise<LocalChromiumStage> {
  if (!EXTENSION_ID.test(input.sourceExtensionId) || !VERSION.test(input.expectedVersion) ||
      !isAbsolute(input.sourceRoot) || !isAbsolute(input.stagingRoot)) throw new Error('Invalid local extension source.')
  const deadline = Date.now() + MAX_DURATION_MS
  const sourceInfo = await lstat(input.sourceRoot)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Local extension source is not a regular directory.')
  const sourceRoot = await realpath(input.sourceRoot)
  if (resolve(input.stagingRoot).toLowerCase() === sourceRoot.toLowerCase() || inside(sourceRoot, resolve(input.stagingRoot))) {
    throw new Error('Extension staging root must be outside the source.')
  }
  const records = await inventory(sourceRoot, signal, deadline, true)
  check(signal, deadline)
  await mkdir(input.stagingRoot, { recursive: true })
  const stagingInfo = await lstat(input.stagingRoot)
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) throw new Error('Extension staging root is unsafe.')
  const stagingRoot = await realpath(input.stagingRoot)
  if (inside(sourceRoot, stagingRoot) || inside(stagingRoot, sourceRoot)) throw new Error('Extension staging root overlaps the source.')
  const root = await mkdtemp(join(stagingRoot, 'local-chromium-'))
  const contentRoot = join(root, 'content')
  try {
    await mkdir(contentRoot)
    for (const record of records) {
      check(signal, deadline)
      const bytes = await sourceBytes(sourceRoot, record.absolutePath, MAX_FILE_BYTES)
      if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256) throw new Error('Extension source changed during staging.')
      const destination = resolve(contentRoot, ...record.relativePath.split('/'))
      if (!inside(contentRoot, destination)) throw new Error('Extension staging path escaped its root.')
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { flag: 'wx' })
      if (sha256(await readFile(destination)) !== record.sha256) throw new Error('Extension copy failed verification.')
    }
    // The source must still match inventory after the final copy, not just while each file is read.
    const finalRecords = await inventory(sourceRoot, signal, deadline, true)
    if (JSON.stringify(finalRecords) !== JSON.stringify(records)) throw new Error('Extension source changed during staging.')
    const manifest = records.find((record) => record.relativePath === 'manifest.json')!
    const manifestValue = JSON.parse(await readFile(join(contentRoot, 'manifest.json'), 'utf8')) as { version?: unknown }
    if (manifestValue.version !== input.expectedVersion) throw new Error('Extension version changed during staging.')
    return {
      root, contentRoot, sourceExtensionId: input.sourceExtensionId, version: input.expectedVersion,
      fingerprint: fingerprint(records), manifestSha256: manifest.sha256,
      fileCount: records.length, byteCount: records.reduce((sum, record) => sum + record.size, 0)
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function verifyLocalChromiumStage(stage: LocalChromiumStage, signal: AbortSignal): Promise<void> {
  const content = await realpath(stage.contentRoot)
  const root = await realpath(stage.root)
  if (!inside(root, content)) throw new Error('Staged extension root escaped its temporary directory.')
  const records = await inventory(content, signal, Date.now() + MAX_DURATION_MS)
  const manifest = records.find((record) => record.relativePath === 'manifest.json')
  if (fingerprint(records) !== stage.fingerprint || manifest?.sha256 !== stage.manifestSha256 ||
      records.length !== stage.fileCount || records.reduce((sum, record) => sum + record.size, 0) !== stage.byteCount) {
    throw new Error('Staged extension content changed after copying.')
  }
}

export async function verifyLocalChromiumCopy(contentRoot: string, expectedFingerprint: string, signal: AbortSignal): Promise<void> {
  const root = await realpath(contentRoot)
  const records = await inventory(root, signal, Date.now() + MAX_DURATION_MS)
  if (fingerprint(records) !== expectedFingerprint) throw new Error('Installed local extension copy changed.')
}
