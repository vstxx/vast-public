import { errorResponse, jsonResponse } from '../shared/http'
import { ValidationError, validateSemVer, validateUuid } from '../shared/validation'

interface AggregateRow {
  total_installations: number
  active_24h: number
  active_7d: number
  active_30d: number
  new_24h: number
  new_7d: number
  new_30d: number
  launch_count_average: number | null
  launch_count_maximum: number | null
  launch_count_total: number | null
}

interface VersionRow {
  version: string
  count: number
}

interface InstallationRow {
  install_id: string
  current_version: string
  first_seen: number
  last_seen: number
  launch_count: number
}

type InstallationActivity = 'all' | '24h' | '7d' | '30d'

interface InstallationCursor {
  last_seen: number
  install_id: string
}

const INSTALLATION_PAGE_SIZE = 25
const INSTALLATION_PAGE_SIZE_MAX = 100

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback
  if (!/^\d{1,3}$/.test(value)) throw new ValidationError('limit must be a positive integer.')
  const parsed = Number(value)
  if (parsed < 1 || parsed > INSTALLATION_PAGE_SIZE_MAX) {
    throw new ValidationError(`limit must be between 1 and ${INSTALLATION_PAGE_SIZE_MAX}.`)
  }
  return parsed
}

function encodeCursor(row: InstallationRow): string {
  return btoa(JSON.stringify({ last_seen: row.last_seen, install_id: row.install_id } satisfies InstallationCursor))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function decodeCursor(value: string): InstallationCursor {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new ValidationError('cursor is invalid.')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  let parsed: unknown
  try {
    parsed = JSON.parse(atob(padded)) as unknown
  } catch {
    throw new ValidationError('cursor is invalid.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('cursor is invalid.')
  }
  const source = parsed as Record<string, unknown>
  if (
    Object.keys(source).length !== 2
    || !Object.hasOwn(source, 'last_seen')
    || !Object.hasOwn(source, 'install_id')
    || !Number.isSafeInteger(source.last_seen)
    || Number(source.last_seen) < 0
  ) {
    throw new ValidationError('cursor is invalid.')
  }
  return {
    last_seen: Number(source.last_seen),
    install_id: validateUuid(source.install_id)
  }
}

function installationJson(row: InstallationRow) {
  return {
    install_id: row.install_id,
    current_version: row.current_version,
    first_seen: new Date(row.first_seen).toISOString(),
    last_seen: new Date(row.last_seen).toISOString(),
    launch_count: row.launch_count
  }
}

export async function dashboardSummary(env: AdminEnv, now = Date.now()): Promise<Response> {
  const day = 24 * 60 * 60 * 1000
  const [aggregate, versions] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS total_installations,
        COALESCE(SUM(last_seen >= ?), 0) AS active_24h,
        COALESCE(SUM(last_seen >= ?), 0) AS active_7d,
        COALESCE(SUM(last_seen >= ?), 0) AS active_30d,
        COALESCE(SUM(first_seen >= ?), 0) AS new_24h,
        COALESCE(SUM(first_seen >= ?), 0) AS new_7d,
        COALESCE(SUM(first_seen >= ?), 0) AS new_30d,
        AVG(launch_count) AS launch_count_average,
        MAX(launch_count) AS launch_count_maximum,
        SUM(launch_count) AS launch_count_total
      FROM installations
    `).bind(
      now - day,
      now - 7 * day,
      now - 30 * day,
      now - day,
      now - 7 * day,
      now - 30 * day
    ).first<AggregateRow>(),
    env.DB.prepare(`
      SELECT current_version AS version, COUNT(*) AS count
      FROM installations
      GROUP BY current_version
      ORDER BY count DESC, current_version DESC
      LIMIT 100
    `).all<VersionRow>()
  ])
  const safe = aggregate ?? {
    total_installations: 0,
    active_24h: 0,
    active_7d: 0,
    active_30d: 0,
    new_24h: 0,
    new_7d: 0,
    new_30d: 0,
    launch_count_average: null,
    launch_count_maximum: null,
    launch_count_total: null
  }
  return jsonResponse({
    generated_at: new Date(now).toISOString(),
    totals: {
      installations: safe.total_installations,
      active_24h: safe.active_24h,
      active_7d: safe.active_7d,
      active_30d: safe.active_30d,
      new_24h: safe.new_24h,
      new_7d: safe.new_7d,
      new_30d: safe.new_30d
    },
    launch_counts: {
      average: safe.launch_count_average === null ? null : Number(safe.launch_count_average.toFixed(2)),
      maximum: safe.launch_count_maximum,
      total: safe.launch_count_total
    },
    versions: versions.results.map((row) => ({
      version: row.version,
      count: row.count,
      percentage: safe.total_installations === 0 ? 0 : Number(((row.count / safe.total_installations) * 100).toFixed(2))
    }))
  })
}

export async function getInstallation(env: AdminEnv, rawInstallId: string): Promise<Response> {
  const installId = validateUuid(rawInstallId)
  const row = await env.DB.prepare(`
    SELECT install_id, current_version, first_seen, last_seen, launch_count
    FROM installations WHERE install_id = ?
  `).bind(installId).first<InstallationRow>()
  if (!row) return errorResponse(404, 'installation_not_found')
  return jsonResponse(installationJson(row))
}

export async function listInstallations(request: Request, env: AdminEnv, now = Date.now()): Promise<Response> {
  const url = new URL(request.url)
  const allowedParameters = new Set(['activity', 'version', 'install_id', 'cursor', 'limit'])
  for (const key of url.searchParams.keys()) {
    if (!allowedParameters.has(key)) throw new ValidationError('Unexpected installation query parameter.')
    if (url.searchParams.getAll(key).length !== 1) throw new ValidationError('Installation query parameters must not repeat.')
  }

  const activityValue = url.searchParams.get('activity') ?? 'all'
  if (!['all', '24h', '7d', '30d'].includes(activityValue)) throw new ValidationError('activity is invalid.')
  const activity = activityValue as InstallationActivity
  const versionValue = url.searchParams.get('version')
  const version = versionValue ? validateSemVer(versionValue, 'version') : null
  const installIdValue = url.searchParams.get('install_id')
  const installId = installIdValue ? validateUuid(installIdValue) : null
  const cursorValue = url.searchParams.get('cursor')
  const cursor = cursorValue ? decodeCursor(cursorValue) : null
  const limit = positiveInteger(url.searchParams.get('limit'), INSTALLATION_PAGE_SIZE)

  const filters: string[] = []
  const filterBindings: Array<string | number> = []
  const activityDays: Record<Exclude<InstallationActivity, 'all'>, number> = { '24h': 1, '7d': 7, '30d': 30 }
  if (activity !== 'all') {
    filters.push('last_seen >= ?')
    filterBindings.push(now - activityDays[activity] * 86_400_000)
  }
  if (version) {
    filters.push('current_version = ?')
    filterBindings.push(version)
  }
  if (installId) {
    filters.push('install_id = ?')
    filterBindings.push(installId)
  }
  const baseWhere = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
  const pageFilters = [...filters]
  const pageBindings = [...filterBindings]
  if (cursor) {
    pageFilters.push('(last_seen < ? OR (last_seen = ? AND install_id > ?))')
    pageBindings.push(cursor.last_seen, cursor.last_seen, cursor.install_id)
  }
  const pageWhere = pageFilters.length > 0 ? `WHERE ${pageFilters.join(' AND ')}` : ''

  const [countRow, result] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM installations ${baseWhere}`)
      .bind(...filterBindings)
      .first<{ count: number }>(),
    env.DB.prepare(`
      SELECT install_id, current_version, first_seen, last_seen, launch_count
      FROM installations
      ${pageWhere}
      ORDER BY last_seen DESC, install_id ASC
      LIMIT ?
    `).bind(...pageBindings, limit + 1).all<InstallationRow>()
  ])

  const hasMore = result.results.length > limit
  const rows = result.results.slice(0, limit)
  return jsonResponse({
    items: rows.map(installationJson),
    total: countRow?.count ?? 0,
    next_cursor: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]) : null
  })
}
