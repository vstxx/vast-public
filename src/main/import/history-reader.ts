import type { DatabaseSync } from 'node:sqlite'
import type { ImportedHistoryEntry } from '../../shared/browser-import.ts'
import type { ImportReadResult } from './bookmark-reader.ts'

const MAX_HISTORY = 1_000
const MAX_SCAN_ROWS = 10_000
const CHROMIUM_EPOCH_US = 11_644_473_600_000_000n
interface HistoryRow {
  url: unknown
  title: unknown
  visits: unknown
  time: unknown
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d{1,22}$/.test(value)) return BigInt(value)
  return null
}

function candidateCount(db: DatabaseSync, sql: string): number | null {
  const count = toBigInt(db.prepare(sql).get()?.n)
  return count !== null && count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null
}

function normalizedUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.href.length <= 2048
      ? parsed.href : null
  } catch { return null }
}

function readRows(rows: Iterable<HistoryRow>, firefox: boolean, totalCandidates: number): ImportReadResult<ImportedHistoryEntry> {
  const result: ImportReadResult<ImportedHistoryEntry> = { items: [], skipped: 0 }
  let scanned = 0
  for (const row of rows) {
    if (++scanned > MAX_SCAN_ROWS) {
      result.error = 'History scan limit exceeded'
      break
    }
    const url = normalizedUrl(row.url)
    const visits = toBigInt(row.visits)
    const rawTime = toBigInt(row.time)
    const unixMicroseconds = rawTime === null ? null : firefox ? rawTime : rawTime - CHROMIUM_EPOCH_US
    const milliseconds = unixMicroseconds === null ? null : unixMicroseconds / 1000n
    if (!url || visits === null || visits <= 0n || visits > BigInt(Number.MAX_SAFE_INTEGER) ||
        milliseconds === null || milliseconds <= 0n || milliseconds > 8_640_000_000_000_000n) continue
    result.items.push({
      url,
      title: typeof row.title === 'string' ? row.title.trim().slice(0, 512) : '',
      visitCount: Number(visits),
      lastVisitedAt: Number(milliseconds)
    })
    if (result.items.length === MAX_HISTORY) break
  }
  result.skipped = Math.max(0, totalCandidates - result.items.length)
  return result
}

function maxFutureMicroseconds(): bigint {
  // A one-year margin accommodates source clock skew without letting obviously
  // corrupted far-future rows displace normal browsing history.
  return BigInt(Date.now() + 366 * 24 * 60 * 60 * 1000) * 1000n
}

export function readChromiumHistory(db: DatabaseSync): ImportReadResult<ImportedHistoryEntry> {
  try {
    const total = candidateCount(db, 'SELECT COUNT(*) AS n FROM urls WHERE hidden = 0')
    if (total === null) return { items: [], skipped: 0, error: 'Chromium history count is invalid' }
    const rows = db.prepare(`SELECT substr(url, 1, 2049) AS url, substr(title, 1, 513) AS title,
      visit_count AS visits, CAST(last_visit_time AS TEXT) AS time
      FROM urls WHERE hidden = 0 AND visit_count > 0
      AND last_visit_time > ? AND last_visit_time <= ?
      AND (url LIKE 'http:%' OR url LIKE 'https:%')
      ORDER BY last_visit_time DESC, id DESC LIMIT ?`
    ).iterate(CHROMIUM_EPOCH_US, CHROMIUM_EPOCH_US + maxFutureMicroseconds(), MAX_SCAN_ROWS + 1) as Iterable<HistoryRow>
    return readRows(rows, false, total)
  } catch {
    return { items: [], skipped: 0, error: 'Chromium history could not be read' }
  }
}

export function readFirefoxHistory(db: DatabaseSync): ImportReadResult<ImportedHistoryEntry> {
  try {
    const total = candidateCount(db, `SELECT COUNT(DISTINCT p.id) AS n FROM moz_places p
      JOIN moz_historyvisits v ON v.place_id = p.id WHERE p.hidden = 0`)
    if (total === null) return { items: [], skipped: 0, error: 'Firefox history count is invalid' }
    const rows = db.prepare(`SELECT substr(p.url, 1, 2049) AS url, substr(p.title, 1, 513) AS title,
      COUNT(v.id) AS visits, CAST(MAX(v.visit_date) AS TEXT) AS time
      FROM moz_places p JOIN moz_historyvisits v ON v.place_id = p.id
      WHERE p.hidden = 0 AND v.visit_date > 0 AND v.visit_date <= ?
      AND (p.url LIKE 'http:%' OR p.url LIKE 'https:%')
      GROUP BY p.id ORDER BY MAX(v.visit_date) DESC, p.id DESC LIMIT ?`
    ).iterate(maxFutureMicroseconds(), MAX_SCAN_ROWS + 1) as Iterable<HistoryRow>
    return readRows(rows, true, total)
  } catch {
    return { items: [], skipped: 0, error: 'Firefox history could not be read' }
  }
}
