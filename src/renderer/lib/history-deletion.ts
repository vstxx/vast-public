import type { HistoryEntry, ID } from '../../shared/types'
import { normalizeSearchText } from './palette-search.ts'

export type HistoryRange = 'hour' | 'day' | 'week' | 'month' | 'all'

export const HISTORY_RANGES: ReadonlyArray<{ id: HistoryRange; label: string }> = [
  { id: 'hour', label: 'Last hour' },
  { id: 'day', label: 'Last 24 hours' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'Last 4 weeks' },
  { id: 'all', label: 'All time' }
]

const RANGE_MS: Record<Exclude<HistoryRange, 'all'>, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 28 * 24 * 60 * 60 * 1000
}

export interface HistorySelection {
  ids?: readonly ID[]
  host?: string
  query?: string
  range?: HistoryRange
  // Restricts deletion to one workspace's history; omitted means every workspace.
  workspaceId?: ID
}

export function historyHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Same matching as the History panel search box, so "Delete N matching" deletes what is shown. */
export function historyMatchesQuery(entry: Pick<HistoryEntry, 'title' | 'url'>, query: string): boolean {
  const needle = normalizeSearchText(query.trim())
  return !needle || normalizeSearchText(`${entry.title} ${entry.url}`).includes(needle)
}

export function selectHistoryIds(history: readonly HistoryEntry[], selection: HistorySelection, now = Date.now()): ID[] {
  const ids = selection.ids ? new Set(selection.ids) : undefined
  const since = selection.range && selection.range !== 'all' ? now - RANGE_MS[selection.range] : undefined
  return history
    .filter((entry) =>
      (!ids || ids.has(entry.id)) &&
      (!selection.host || historyHost(entry.url) === selection.host) &&
      (!selection.query || historyMatchesQuery(entry, selection.query)) &&
      (since === undefined || entry.lastVisitedAt >= since) &&
      (!selection.workspaceId || entry.workspaceId === selection.workspaceId))
    .map((entry) => entry.id)
}

/** Puts removed entries back without duplicating pages that were visited again meanwhile. */
export function mergeRestoredHistory(current: readonly HistoryEntry[], restored: readonly HistoryEntry[], limit = 1000): HistoryEntry[] {
  const byUrl = new Map<string, HistoryEntry>()
  for (const entry of [...restored, ...current]) {
    const existing = byUrl.get(entry.url)
    if (!existing) byUrl.set(entry.url, entry)
    else if (entry.lastVisitedAt > existing.lastVisitedAt) {
      byUrl.set(entry.url, { ...entry, visitCount: Math.max(entry.visitCount, existing.visitCount) })
    }
  }
  return [...byUrl.values()].sort((left, right) => right.lastVisitedAt - left.lastVisitedAt).slice(0, limit)
}
