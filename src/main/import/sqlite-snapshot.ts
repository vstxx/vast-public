import { backup, DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024
const SNAPSHOT_PREFIX = 'snapshot-'

export interface SqliteSnapshotOptions {
  /** Private Vast-owned staging directory. The caller supplies userData/ImportStaging in production. */
  stagingRoot?: string
  /** Internal test override; IPC never controls this limit. */
  maxSourceBytes?: number
}

export async function ensureImportStagingRoot(stagingRoot: string): Promise<string> {
  await mkdir(stagingRoot, { recursive: true })
  const info = await lstat(stagingRoot)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Import staging root is a symlink or junction')
  return await realpath(stagingRoot)
}

export async function cleanupStaleSnapshots(stagingRoot: string): Promise<void> {
  const canonicalRoot = await ensureImportStagingRoot(stagingRoot)
  for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
    if ((!entry.name.startsWith(SNAPSHOT_PREFIX) && !entry.name.startsWith('worker-')) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = join(stagingRoot, entry.name)
    const canonicalCandidate = await realpath(candidate)
    const next = relative(canonicalRoot, canonicalCandidate)
    if (!next || next === '..' || next.startsWith(`..${sep}`) || isAbsolute(next)) continue
    await rm(candidate, { recursive: true, force: true })
  }
}

async function validateWalSidecar(source: string, maxSourceBytes: number): Promise<number> {
  const path = `${source}-wal`
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxSourceBytes) {
    throw new Error('SQLite WAL sidecar is invalid or exceeds the size limit')
  }
  if (info.size === 0) return 0
  if (info.size < 32) throw new Error('SQLite WAL sidecar has a truncated header')
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(32)
    const { bytesRead } = await handle.read(header, 0, 32, 0)
    const magic = header.readUInt32BE(0)
    if (bytesRead !== 32 || (magic !== 0x377f0682 && magic !== 0x377f0683) || header.readUInt32BE(4) !== 3_007_000) {
      throw new Error('SQLite WAL sidecar has an invalid header')
    }
  } finally {
    await handle.close()
  }
  return info.size
}

/** SQLite's online-backup API captures WAL content atomically; sidecars are never copied separately. */
export async function withSqliteSnapshot<T>(
  sourcePath: string,
  read: (db: DatabaseSync) => T,
  options: SqliteSnapshotOptions = {}
): Promise<T> {
  const source = resolve(sourcePath)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('SQLite source is not a regular file')
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0 || info.size > maxSourceBytes) {
    throw new Error('SQLite source size limit exceeded')
  }
  const walBytes = await validateWalSidecar(source, maxSourceBytes)
  if (info.size + walBytes > maxSourceBytes) throw new Error('SQLite source aggregate size limit exceeded')

  const stagingRoot = resolve(options.stagingRoot ?? join(tmpdir(), 'VastBrowserImportStaging'))
  await ensureImportStagingRoot(stagingRoot)
  const snapshotDir = await mkdtemp(join(stagingRoot, SNAPSHOT_PREFIX))
  let sourceDb: DatabaseSync | undefined
  let snapshotDb: DatabaseSync | undefined
  try {
    sourceDb = new DatabaseSync(source, { readOnly: true, readBigInts: true, timeout: 1000 })
    const snapshotPath = join(snapshotDir, 'db.sqlite')
    const pageSize = Number(sourceDb.prepare('PRAGMA page_size').get()?.page_size)
    const pageCount = Number(sourceDb.prepare('PRAGMA page_count').get()?.page_count)
    if (!Number.isSafeInteger(pageSize) || !Number.isSafeInteger(pageCount) || pageSize <= 0 || pageCount * pageSize > maxSourceBytes) {
      throw new Error('SQLite logical size limit exceeded')
    }
    let budgetExceeded = false
    try {
      await backup(sourceDb, snapshotPath, {
        rate: 32,
        progress: ({ totalPages }) => {
          if (totalPages * pageSize > maxSourceBytes) {
            budgetExceeded = true
            throw new Error('SQLite snapshot size limit exceeded')
          }
        }
      })
    } catch {
      if (budgetExceeded) throw new Error('SQLite snapshot size limit exceeded')
      throw new Error('SQLite snapshot backup failed')
    }
    sourceDb.close()
    sourceDb = undefined

    const outputInfo = await stat(snapshotPath)
    if (outputInfo.size > maxSourceBytes) throw new Error('SQLite snapshot size limit exceeded')
    snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true, readBigInts: true })
    const integrity = snapshotDb.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error('SQLite snapshot integrity check failed')
    return read(snapshotDb)
  } finally {
    snapshotDb?.close()
    sourceDb?.close()
    // Only the directory created above is removed; never the caller's source or staging root.
    if (basename(snapshotDir).startsWith(SNAPSHOT_PREFIX)) {
      await rm(snapshotDir, { recursive: true, force: true })
    }
  }
}
