import semver from 'semver'
import { jsonResponse } from '../shared/http'
import { ValidationError } from '../shared/validation'

const DAY = 86_400_000
const BASE = 900_000
const RETENTION = 60 * DAY
const RANGES = { '24h': DAY, '7d': 7 * DAY, '14d': 14 * DAY, '30d': 30 * DAY, '60d': 60 * DAY } as const
const RESOLUTIONS = { '24h': BASE, '7d': 3_600_000, '14d': 7_200_000, '30d': 14_400_000, '60d': 43_200_000 } as const
const COHORTS = ['all', 'packaged', 'development', 'test', 'unknown'] as const
export type AnalyticsRange = keyof typeof RANGES
export type AnalyticsCohort = typeof COHORTS[number]

interface MetricRow {
  bucket_ts: number
  collected_at: number
  source: 'measured' | 'synthetic_local'
  cohort: AnalyticsCohort
  total_installations: number
  active_24h: number
  active_7d: number
  active_30d: number
  new_24h: number
  new_7d: number
  new_30d: number
  cumulative_launch_count: number
  average_launch_count: number
  maximum_launch_count: number
}

interface VersionRow { bucket_ts: number; version: string; installation_count: number }
interface DayRow { day: number; count: number }

export function parseAnalyticsQuery(url: URL): { range: AnalyticsRange; cohort: AnalyticsCohort } {
  for (const key of url.searchParams.keys()) {
    if (!['range', 'cohort'].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError('Invalid analytics query parameters.')
    }
  }
  const range = url.searchParams.get('range') ?? '14d'
  const cohort = url.searchParams.get('cohort') ?? 'packaged'
  if (!(range in RANGES)) throw new ValidationError('range is invalid.')
  if (!COHORTS.includes(cohort as AnalyticsCohort)) throw new ValidationError('cohort is invalid.')
  return { range: range as AnalyticsRange, cohort: cohort as AnalyticsCohort }
}

/** The version rows are inserted first. The metric row acts as the transaction's completion marker. */
export async function collectAnalyticsSnapshot(db: D1Database, now = Date.now()): Promise<void> {
  const bucket = Math.floor(now / BASE) * BASE
  const cohorts = "('all'),('packaged'),('development'),('test'),('unknown')"
  const versions = db.prepare(`
    WITH cohorts(cohort) AS (VALUES ${cohorts})
    INSERT INTO analytics_version_snapshots (bucket_ts, cohort, version, installation_count)
    SELECT ?, c.cohort, i.current_version, COUNT(*)
    FROM cohorts c JOIN installations i ON (c.cohort = 'all' OR c.cohort = i.instance_kind)
    WHERE i.first_seen <= ? AND NOT EXISTS (
      SELECT 1 FROM analytics_metric_snapshots m WHERE m.bucket_ts = ? AND m.cohort = 'all'
    )
    GROUP BY c.cohort, i.current_version
  `).bind(bucket, now, bucket)
  const metrics = db.prepare(`
    WITH cohorts(cohort) AS (VALUES ${cohorts})
    INSERT OR IGNORE INTO analytics_metric_snapshots (
      bucket_ts, cohort, collected_at, total_installations, active_24h, active_7d, active_30d,
      new_24h, new_7d, new_30d, cumulative_launch_count, average_launch_count, maximum_launch_count
    )
    SELECT ?, c.cohort, ?, COUNT(i.install_id),
      COALESCE(SUM(i.last_seen BETWEEN ? AND ?), 0),
      COALESCE(SUM(i.last_seen BETWEEN ? AND ?), 0),
      COALESCE(SUM(i.last_seen BETWEEN ? AND ?), 0),
      COALESCE(SUM(i.first_seen BETWEEN ? AND ?), 0),
      COALESCE(SUM(i.first_seen BETWEEN ? AND ?), 0),
      COALESCE(SUM(i.first_seen BETWEEN ? AND ?), 0),
      COALESCE(SUM(i.launch_count), 0), COALESCE(AVG(i.launch_count), 0), COALESCE(MAX(i.launch_count), 0)
    FROM cohorts c LEFT JOIN installations i
      ON (c.cohort = 'all' OR c.cohort = i.instance_kind) AND i.first_seen <= ?
    GROUP BY c.cohort
  `).bind(bucket, now,
    now - DAY, now, now - 7 * DAY, now, now - 30 * DAY, now,
    now - DAY, now, now - 7 * DAY, now, now - 30 * DAY, now, now)
  await db.batch([versions, metrics])
}

export async function retainAnalyticsSnapshots(db: D1Database, now = Date.now()): Promise<void> {
  const before = now - RETENTION
  await db.batch([
    db.prepare('DELETE FROM analytics_version_snapshots WHERE bucket_ts < ?').bind(before),
    db.prepare('DELETE FROM analytics_metric_snapshots WHERE bucket_ts < ?').bind(before)
  ])
}

export function sampleLatest<T extends { bucket_ts: number }>(rows: T[], resolution: number): T[] {
  const buckets = new Map<number, T>()
  for (const row of rows) buckets.set(Math.floor(row.bucket_ts / resolution), row)
  return [...buckets.values()].sort((a, b) => a.bucket_ts - b.bucket_ts)
}

export function launchDifferences<T extends { bucket_ts: number; cumulative_launch_count: number }>(rows: T[], expectedInterval = BASE): Array<number | null> {
  return rows.slice(1).map((row, index) => {
    const previous = rows[index]
    const elapsed = row.bucket_ts - previous.bucket_ts
    const delta = row.cumulative_launch_count - previous.cumulative_launch_count
    return elapsed > 0 && elapsed <= expectedInterval * 1.5 && delta >= 0 ? delta : null
  })
}

function periodLaunches(rows: MetricRow[], start: number, end: number): number | null {
  const baseline = nearest(rows, start)
  const finish = nearest(rows, end)
  if (!baseline || !finish || finish.bucket_ts <= baseline.bucket_ts) return null
  const relevant = rows.filter((row) => row.bucket_ts >= baseline.bucket_ts && row.bucket_ts <= finish.bucket_ts)
  const deltas = launchDifferences(relevant)
  if (!deltas.length || deltas.some((delta) => delta === null)) return null
  return deltas.reduce<number>((sum, delta) => sum + (delta ?? 0), 0)
}

function iso(time: number): string { return new Date(time).toISOString() }
function nearest(rows: MetricRow[], time: number): MetricRow | null {
  let found: MetricRow | null = null
  for (const row of rows) if (row.bucket_ts <= time && time - row.bucket_ts <= 30 * 60_000) found = row
  return found
}
function versionPercent(count: number, total: number): number { return total ? Math.round(count / total * 10_000) / 100 : 0 }

export async function getAnalytics(request: Request, env: AdminEnv, now = Date.now()): Promise<Response> {
  const { range, cohort } = parseAnalyticsQuery(new URL(request.url))
  const duration = RANGES[range]
  const resolution = RESOLUTIONS[range]
  const start = now - duration
  const previousStart = start - duration
  const condition = cohort === 'all' ? '' : ' AND instance_kind = ?'
  const bindings = cohort === 'all' ? [] : [cohort]
  const [snapshotResult, firstResult, dailyResult, periodResult, previousResult, releaseResult, demoResult, latestResult] = await Promise.all([
    env.DB.prepare('SELECT * FROM analytics_metric_snapshots WHERE cohort = ? AND bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts')
      .bind(cohort, Math.max(previousStart - BASE, now - RETENTION), now).all<MetricRow>(),
    env.DB.prepare('SELECT MIN(bucket_ts) AS first FROM analytics_metric_snapshots WHERE cohort = ?')
      .bind(cohort).first<{ first: number | null }>(),
    env.DB.prepare(`SELECT CAST(first_seen / ? AS INTEGER) AS day, COUNT(*) AS count FROM installations WHERE first_seen >= ? AND first_seen <= ?${condition} GROUP BY day ORDER BY day`)
      .bind(DAY, Math.floor(start / DAY) * DAY, now, ...bindings).all<DayRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM installations WHERE first_seen > ? AND first_seen <= ?${condition}`)
      .bind(start, now, ...bindings).first<{ count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM installations WHERE first_seen > ? AND first_seen <= ?${condition}`)
      .bind(previousStart, start, ...bindings).first<{ count: number }>(),
    env.DB.prepare('SELECT version, published_at FROM releases WHERE enabled = 1 AND published_at <= ? ORDER BY published_at DESC LIMIT 100')
      .bind(now).all<{ version: string; published_at: number }>(),
    env.DB.prepare("SELECT 1 AS present FROM analytics_metric_snapshots WHERE source = 'synthetic_local' LIMIT 1")
      .first<{ present: number }>(),
    env.DB.prepare('SELECT * FROM analytics_metric_snapshots WHERE cohort = ? ORDER BY bucket_ts DESC LIMIT 1')
      .bind(cohort).first<MetricRow>()
  ])
  const rows = snapshotResult.results
  const selected = rows.filter((row) => row.bucket_ts >= start)
  const latestStored = latestResult ?? null
  const latest = latestStored && latestStored.bucket_ts <= now && now - latestStored.bucket_ts <= 30 * 60_000 ? latestStored : null
  const previous = nearest(rows, start)
  const displayed = sampleLatest(selected, resolution)
  const priorDisplayed = sampleLatest(rows.filter((row) => row.bucket_ts >= previousStart && row.bucket_ts < start), resolution)
  const latestVersions = latest
    ? (await env.DB.prepare('SELECT bucket_ts, version, installation_count FROM analytics_version_snapshots WHERE cohort = ? AND bucket_ts = ? ORDER BY installation_count DESC, version DESC')
      .bind(cohort, latest.bucket_ts).all<VersionRow>()).results
    : []
  const releases = releaseResult.results.filter((row) => semver.valid(row.version))
  releases.sort((a, b) => semver.rcompare(a.version, b.version))
  const observedVersions = latestVersions.map((row) => row.version).filter((version) => semver.valid(version)).sort(semver.rcompare)
  const latestRelease = releases[0] ?? (observedVersions[0] ? { version: observedVersions[0], published_at: null } : null)
  const topVersions = [...new Set([latestRelease?.version, ...latestVersions.slice(0, 4).map((row) => row.version)].filter((value): value is string => !!value))].slice(0, 5)
  let versionHistory: VersionRow[] = []
  if (topVersions.length && displayed.length) {
    const versionMarks = topVersions.map(() => '?').join(',')
    versionHistory = (await env.DB.prepare(`
      SELECT v.bucket_ts, v.version, v.installation_count
      FROM analytics_version_snapshots v
      JOIN (
        SELECT MAX(bucket_ts) AS bucket_ts FROM analytics_metric_snapshots
        WHERE cohort = ? AND bucket_ts >= ? AND bucket_ts <= ?
        GROUP BY CAST(bucket_ts / ? AS INTEGER)
      ) samples ON samples.bucket_ts = v.bucket_ts
      WHERE v.cohort = ? AND v.version IN (${versionMarks})
      ORDER BY v.bucket_ts
    `).bind(cohort, start, now, resolution, cohort, ...topVersions).all<VersionRow>()).results
  }
  const totalsByTime = new Map(selected.map((row) => [row.bucket_ts, row.total_installations]))
  const versionCounts = new Map(versionHistory.map((row) => [`${row.bucket_ts}:${row.version}`, row.installation_count]))
  const adoption = topVersions.map((version) => ({
    version,
    points: displayed.map((row) => ({ timestamp: iso(row.bucket_ts), percentage: versionPercent(versionCounts.get(`${row.bucket_ts}:${version}`) ?? 0, totalsByTime.get(row.bucket_ts) ?? 0) }))
  }))
  const versionDistribution = latestVersions.map((row) => ({
    version: row.version, count: row.installation_count,
    percentage: versionPercent(row.installation_count, latest?.total_installations ?? 0)
  }))
  const latestAdoption = latestRelease ? (versionDistribution.find((row) => row.version === latestRelease.version)?.percentage ?? 0) : null
  const previousVersions = previous && latestRelease
    ? (await env.DB.prepare('SELECT installation_count FROM analytics_version_snapshots WHERE cohort = ? AND bucket_ts = ? AND version = ?')
      .bind(cohort, previous.bucket_ts, latestRelease.version).first<{ installation_count: number }>())
    : null
  const previousAdoption = previous && latestRelease
    ? versionPercent(previousVersions?.installation_count ?? 0, previous.total_installations) : null
  const startDay = Math.floor(start / DAY) * DAY
  const baseCount = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM installations WHERE first_seen < ?${condition}`)
    .bind(startDay, ...bindings).first<{ count: number }>())?.count ?? 0
  const dayMap = new Map(dailyResult.results.map((row) => [row.day, row.count]))
  let cumulative = baseCount
  const daily: Array<{ day: string; count: number; cumulative_total: number }> = []
  for (let day = startDay; day <= now; day += DAY) {
    const count = dayMap.get(Math.floor(day / DAY)) ?? 0
    cumulative += count
    daily.push({ day: iso(day), count, cumulative_total: cumulative })
  }
  const rawForLaunches = rows.filter((row) => row.bucket_ts >= start - 30 * 60_000)
  const launchDeltas = launchDifferences(rawForLaunches)
  const rawLaunchPoints = rawForLaunches.slice(1).map((row, index) => ({ timestamp: iso(row.bucket_ts), count: launchDeltas[index] }))
    .filter((point) => Date.parse(point.timestamp) >= start)
  const launchBuckets = new Map<number, { timestamp: string; count: number | null }>()
  for (const point of rawLaunchPoints) {
    const key = Math.floor(Date.parse(point.timestamp) / resolution)
    const existing = launchBuckets.get(key)
    launchBuckets.set(key, { timestamp: point.timestamp, count: point.count === null || existing?.count === null ? null : (existing?.count ?? 0) + point.count })
  }
  const launchPoints = [...launchBuckets.values()].map((point, index, all) => {
    const recent = all.slice(Math.max(0, index - 3), index + 1).map((entry) => entry.count)
    return { ...point, moving_average: recent.length === 4 && recent.every((value) => value !== null)
      ? recent.reduce<number>((sum, value) => sum + (value ?? 0), 0) / 4 : null }
  })
  const launchTotal = periodLaunches(rows, start, now)
  const previousLaunchTotal = periodLaunches(rows, previousStart, start)
  const validDeltas = rawLaunchPoints.map((point) => point.count).filter((value): value is number => value !== null)
  const changes: Array<{ kind: string; message: string; timestamp: string }> = []
  if (latest && previous && latest.active_24h >= 20 && previous.active_24h >= 20) {
    const ratio = latest.active_24h / previous.active_24h
    if (ratio >= 1.3) changes.push({ kind: 'activity_up', message: 'Active 24h is at least 30% above the previous period.', timestamp: iso(latest.bucket_ts) })
    if (ratio <= 0.7) changes.push({ kind: 'activity_down', message: 'Active 24h is at least 30% below the previous period.', timestamp: iso(latest.bucket_ts) })
  }
  if (latestAdoption !== null && previousAdoption !== null) {
    for (const threshold of [50, 75, 90]) {
      if (previousAdoption < threshold && latestAdoption >= threshold) changes.push({ kind: 'adoption', message: `${latestRelease?.version} crossed ${threshold}% adoption.`, timestamp: iso(latest?.bucket_ts ?? now) })
    }
  }
  const completedDays = daily.slice(1, -1)
  if (completedDays.length >= 8) {
    const recent = completedDays.slice(-8)
    const baseline = recent.slice(0, 7).reduce((sum, day) => sum + day.count, 0) / 7
    const last = recent[7]
    if (baseline >= 5 && last.count >= Math.max(15, baseline * 2.5)) {
      changes.push({ kind: 'install_spike', message: `New installations reached ${last.count} on ${iso(Date.parse(last.day)).slice(0, 10)} UTC.`, timestamp: last.day })
    }
  }
  if (validDeltas.length >= 96) {
    const sorted = [...validDeltas].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const peak = Math.max(...validDeltas)
    if (median >= 3 && peak >= Math.max(20, median * 4)) {
      changes.push({ kind: 'launch_spike', message: `A measured interval reached ${peak} launches, over four times the median.`, timestamp: iso(latest?.bucket_ts ?? now) })
    }
  }
  return jsonResponse({
    generated_at: iso(now), history_available_from: firstResult?.first === null || firstResult?.first === undefined ? null : iso(firstResult.first),
    data_source: demoResult ? 'synthetic_local' : 'measured',
    latest_snapshot_at: latestStored ? iso(latestStored.collected_at) : null,
    range, cohort, resolution_ms: resolution,
    period: { from: iso(start), to: iso(now), previous_from: iso(previousStart) },
    current: {
      active_24h: latest?.active_24h ?? null, total_installations: latest?.total_installations ?? null,
      active_30d: latest?.active_30d ?? null,
      inactive_30d: latest ? latest.total_installations - latest.active_30d : null,
      new_installs_period: periodResult?.count ?? 0,
      launches_period: launchTotal, latest_version_adoption: latestAdoption
    },
    previous: {
      active_24h: previous?.active_24h ?? null,
      total_installations: previous?.total_installations ?? null,
      inactive_30d: previous ? previous.total_installations - previous.active_30d : null,
      new_installs_period: previousResult?.count ?? 0,
      launches_period: previousLaunchTotal,
      latest_version_adoption: previousAdoption
    },
    series: displayed.map((row) => ({ timestamp: iso(row.bucket_ts), active_24h: row.active_24h, total_installations: row.total_installations, inactive_30d: row.total_installations - row.active_30d, cumulative_launch_count: row.cumulative_launch_count })),
    previous_series: priorDisplayed.map((row) => ({ timestamp: iso(row.bucket_ts), active_24h: row.active_24h })),
    daily_new_installs: daily,
    launch_activity: { points: launchPoints, period_total: launchTotal, biggest_spike: validDeltas.length ? Math.max(...validDeltas) : null },
    current_version_distribution: versionDistribution,
    version_adoption: adoption,
    latest_release: latestRelease ? { version: latestRelease.version, published_at: latestRelease.published_at === null ? null : iso(latestRelease.published_at), source: latestRelease.published_at === null ? 'observed' : 'published' } : null,
    changes
  })
}
