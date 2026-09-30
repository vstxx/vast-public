import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportedBookmarkEntry } from '../../shared/browser-import.ts'

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_BOOKMARKS = 5_000
const MAX_FOLDERS = 1_000
const MAX_NODES = 6_000
const MAX_DEPTH = 6

export interface ImportReadResult<T> {
  items: T[]
  skipped: number
  error?: string
}

function text(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, length) : ''
}

function url(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.href.length <= 2048
      ? parsed.href : null
  } catch { return null }
}

function numericId(value: unknown): string | null {
  if (typeof value === 'bigint') return value > 0n ? value.toString() : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value === 'string') return /^\d{1,20}$/.test(value) ? value : null
  return null
}

interface ChromiumNode {
  type?: unknown
  id?: unknown
  name?: unknown
  url?: unknown
  children?: unknown
}

function countLeaves(node: unknown, remainingBudget: number): { leaves: number; visited: number } | null {
  const pending = [node]
  let visited = 0
  let count = 0
  while (pending.length) {
    if (visited++ >= remainingBudget) return null
    const next = pending.pop()
    if (!next || typeof next !== 'object') continue
    const item = next as ChromiumNode
    if (item.type === 'url') count++
    else if (item.type === 'folder' && Array.isArray(item.children)) {
      for (const child of item.children) pending.push(child)
    }
  }
  return { leaves: count, visited }
}

/** Pure iterative reader over a bounded parsed Bookmarks JSON tree. */
function collectChromium(data: unknown): ImportReadResult<ImportedBookmarkEntry> {
  const result: ImportReadResult<ImportedBookmarkEntry> = { items: [], skipped: 0 }
  if (!data || typeof data !== 'object') return { ...result, error: 'Invalid Bookmarks root' }
  const roots = (data as { roots?: unknown }).roots
  if (!roots || typeof roots !== 'object') return { ...result, error: 'Missing Bookmarks roots' }
  const stack: Array<{
    node: unknown
    root: ImportedBookmarkEntry['root']
    folderPath: string[]
    folderSourceIds: string[]
  }> = []
  const rootNames: Array<[string, ImportedBookmarkEntry['root']]> = [
    ['synced', 'mobile'], ['other', 'other'], ['bookmark_bar', 'bar']
  ]
  for (const [key, root] of rootNames) {
    const node = (roots as Record<string, unknown>)[key] as ChromiumNode | undefined
    if (!Array.isArray(node?.children)) continue
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index], root, folderPath: [], folderSourceIds: [] })
    }
  }
  let folders = 0
  let visited = 0
  const seenBookmarkIds = new Set<string>()
  while (stack.length > 0) {
    if (visited++ >= MAX_NODES) {
      result.error = 'Bookmark node limit exceeded'
      result.skipped += stack.length
      break
    }
    const current = stack.pop()!
    if (!current.node || typeof current.node !== 'object') { result.skipped++; continue }
    const node = current.node as ChromiumNode
    const sourceItemId = numericId(node.id)
    if (node.type === 'url') {
      const normalized = url(node.url)
      if (!normalized || !sourceItemId || seenBookmarkIds.has(sourceItemId)) { result.skipped++; continue }
      if (result.items.length >= MAX_BOOKMARKS) {
        result.error = 'Bookmark count limit exceeded'
        result.skipped += stack.length + 1
        break
      }
      seenBookmarkIds.add(sourceItemId)
      result.items.push({
        title: text(node.name, 512), url: normalized, root: current.root, sourceItemId,
        folderPath: current.folderPath, folderSourceIds: current.folderSourceIds
      })
      continue
    }
    if (node.type !== 'folder' || !Array.isArray(node.children)) { result.skipped++; continue }
    if (!sourceItemId || current.folderPath.length >= MAX_DEPTH) {
      const skipped = countLeaves(node, MAX_NODES - visited)
      if (skipped === null) { result.error = 'Bookmark subtree limit exceeded'; break }
      visited += skipped.visited
      result.skipped += skipped.leaves
      continue
    }
    if (++folders > MAX_FOLDERS) {
      result.error = 'Bookmark folder limit exceeded'
      result.skipped += stack.length + 1
      break
    }
    const title = text(node.name, 64) || 'Untitled folder'
    const folderPath = [...current.folderPath, title]
    const folderSourceIds = [...current.folderSourceIds, sourceItemId]
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: node.children[index], root: current.root, folderPath, folderSourceIds
      })
    }
  }
  return result
}

export async function readChromiumBookmarks(profilePath: string): Promise<ImportReadResult<ImportedBookmarkEntry>> {
  try {
    const path = join(profilePath, 'Bookmarks')
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      const pathInfo = await lstat(path)
      if (!info.isFile() || !pathInfo.isFile() || pathInfo.isSymbolicLink() || info.size === 0 ||
          info.dev !== pathInfo.dev || info.ino !== pathInfo.ino || info.size > MAX_FILE_BYTES) {
        return { items: [], skipped: 0, error: 'Bookmarks file is invalid or exceeds 32 MiB' }
      }
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > MAX_FILE_BYTES) return { items: [], skipped: 0, error: 'Bookmarks file exceeds 32 MiB' }
        chunks.push(chunk.subarray(0, bytesRead))
      }
      try { return collectChromium(JSON.parse(Buffer.concat(chunks, total).toString('utf8'))) }
      catch { return { items: [], skipped: 0, error: 'Invalid Bookmarks JSON' } }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { items: [], skipped: 0, error: (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Bookmarks file could not be found' : 'Bookmarks file could not be read' }
  }
}

interface FirefoxRow {
  id: number | bigint
  type: number | bigint
  title: string | null
  parent: number | bigint
  url: string | null
}

export function readFirefoxBookmarks(db: DatabaseSync): ImportReadResult<ImportedBookmarkEntry> {
  try {
    const roots = db.prepare('SELECT root_name, folder_id FROM moz_bookmarks_roots LIMIT 16').all() as Array<{
      root_name: string; folder_id: number | bigint
    }>
    const rootMap = new Map<string, ImportedBookmarkEntry['root']>()
    const names: Record<string, ImportedBookmarkEntry['root']> = {
      toolbar: 'bar', menu: 'menu', unfiled: 'unfiled', mobile: 'mobile'
    }
    for (const row of roots) {
      const mapped = names[row.root_name]
      const id = numericId(row.folder_id)
      if (mapped && id) rootMap.set(id, mapped)
    }
    if (!rootMap.size) return { items: [], skipped: 0, error: 'Firefox Places roots unavailable' }
    const rows = db.prepare(`SELECT b.id, b.type, b.title, b.parent, p.url
      FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id
      ORDER BY b.id LIMIT ?`).all(MAX_NODES + 1) as unknown as FirefoxRow[]
    if (rows.length > MAX_NODES) return { items: [], skipped: rows.length - MAX_NODES, error: 'Firefox bookmark node limit exceeded' }
    const folderCount = rows.filter((row) => Number(row.type) === 2 && !rootMap.has(numericId(row.id) ?? '')).length
    if (folderCount > MAX_FOLDERS) {
      return { items: [], skipped: folderCount - MAX_FOLDERS, error: 'Firefox bookmark folder limit exceeded' }
    }
    const byId = new Map<string, FirefoxRow>()
    for (const row of rows) {
      const id = numericId(row.id)
      if (id) byId.set(id, row)
    }
    const result: ImportReadResult<ImportedBookmarkEntry> = { items: [], skipped: 0 }
    for (const row of rows) {
      if (Number(row.type) !== 1) continue
      const normalized = url(row.url)
      const sourceItemId = numericId(row.id)
      if (!normalized || !sourceItemId) { result.skipped++; continue }
      const folderPath: string[] = []
      const folderSourceIds: string[] = []
      const seen = new Set<string>()
      let ancestor = numericId(row.parent)
      let root: ImportedBookmarkEntry['root'] | undefined
      while (ancestor) {
        root = rootMap.get(ancestor)
        if (root) break
        if (seen.has(ancestor) || folderPath.length >= MAX_DEPTH) break
        seen.add(ancestor)
        const folder = byId.get(ancestor)
        if (!folder || Number(folder.type) !== 2) break
        const title = text(folder.title, 64) || 'Untitled folder'
        folderPath.unshift(title)
        folderSourceIds.unshift(ancestor)
        ancestor = numericId(folder.parent)
      }
      if (!root) { result.skipped++; continue }
      if (result.items.length >= MAX_BOOKMARKS) {
        result.error = 'Firefox bookmark count limit exceeded'
        result.skipped++
        break
      }
      result.items.push({ title: text(row.title, 512), url: normalized, sourceItemId, root, folderPath, folderSourceIds })
    }
    return result
  } catch {
    return { items: [], skipped: 0, error: 'Firefox bookmarks could not be read' }
  }
}
