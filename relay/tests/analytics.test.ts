import { describe, expect, it } from 'vitest'
import { adminBindings } from './helpers'
import { collectAnalyticsSnapshot, getAnalytics, launchDifferences, parseAnalyticsQuery, retainAnalyticsSnapshots, sampleLatest } from '../src/admin/analytics'
import adminWorker from '../src/admin/index'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-06T12:00:00.000Z')

async function clear(db: D1Database) {
  await db.batch([
    db.prepare('DELETE FROM analytics_version_snapshots'),
    db.prepare('DELETE FROM analytics_metric_snapshots'),
    db.prepare('DELETE FROM installations')
  ])
}

async function installation(db: D1Database, id: string, kind: string, version: string, first: number, last: number, launches: number) {
  await db.prepare('INSERT INTO installations (install_id,current_version,first_seen,last_seen,launch_count,instance_kind) VALUES (?,?,?,?,?,?)')
    .bind(id, version, first, last, launches, kind).run()
}

describe('Relay historical analytics', () => {
  it('validates range and cohort strictly', () => {
    expect(parseAnalyticsQuery(new URL('https://example.test/v1/admin/analytics'))).toEqual({ range: '14d', cohort: 'packaged' })
    expect(() => parseAnalyticsQuery(new URL('https://example.test/v1/admin/analytics?range=90d'))).toThrow()
    expect(() => parseAnalyticsQuery(new URL('https://example.test/v1/admin/analytics?cohort=other'))).toThrow()
    expect(() => parseAnalyticsQuery(new URL('https://example.test/v1/admin/analytics?range=7d&range=14d'))).toThrow()
    expect(() => parseAnalyticsQuery(new URL('https://example.test/v1/admin/analytics?unexpected=1'))).toThrow()
  })

  it('captures all cohorts and versions once per bucket, including zero populations', async () => {
    const { env } = await adminBindings()
    await clear(env.DB)
    await installation(env.DB, '11111111-1111-4111-8111-111111111111', 'packaged', '0.4.3', NOW - DAY, NOW - 1000, 5)
    await installation(env.DB, '22222222-2222-4222-8222-222222222222', 'development', '0.4.2', NOW - 40 * DAY, NOW - 2 * DAY, 9)
    await installation(env.DB, '33333333-3333-4333-8333-333333333333', 'test', '0.4.2', NOW - 2 * DAY, NOW - DAY, 3)
    await collectAnalyticsSnapshot(env.DB, NOW)
    const first = await env.DB.prepare('SELECT * FROM analytics_metric_snapshots WHERE bucket_ts = ? ORDER BY cohort').bind(NOW).all()
    expect(first.results).toHaveLength(5)
    expect(first.results.find((row) => row.cohort === 'all')).toMatchObject({ total_installations: 3, active_24h: 2, cumulative_launch_count: 17, maximum_launch_count: 9 })
    expect(first.results.find((row) => row.cohort === 'unknown')).toMatchObject({ total_installations: 0, active_24h: 0 })
    const versions = await env.DB.prepare('SELECT cohort,version,installation_count FROM analytics_version_snapshots WHERE bucket_ts = ? ORDER BY cohort,version').bind(NOW).all()
    expect(versions.results).toContainEqual({ cohort: 'all', version: '0.4.2', installation_count: 2 })
    await installation(env.DB, '44444444-4444-4444-8444-444444444444', 'packaged', '0.4.4', NOW, NOW, 1)
    await collectAnalyticsSnapshot(env.DB, NOW + 1000)
    expect((await env.DB.prepare('SELECT total_installations FROM analytics_metric_snapshots WHERE bucket_ts = ? AND cohort = ?').bind(NOW, 'all').first<{ total_installations: number }>())?.total_installations).toBe(3)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM analytics_version_snapshots WHERE bucket_ts = ? AND version = ?').bind(NOW, '0.4.4').first<{ n: number }>())?.n).toBe(0)
  })

  it('retains 60 days of snapshots without touching installation registry', async () => {
    const { env } = await adminBindings()
    await clear(env.DB)
    await installation(env.DB, '11111111-1111-4111-8111-111111111111', 'packaged', '0.4.3', NOW - 70 * DAY, NOW, 2)
    await collectAnalyticsSnapshot(env.DB, NOW - 61 * DAY)
    await collectAnalyticsSnapshot(env.DB, NOW)
    await retainAnalyticsSnapshots(env.DB, NOW)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM analytics_metric_snapshots').first<{ n: number }>())?.n).toBe(5)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM analytics_version_snapshots').first<{ n: number }>())?.n).toBe(2)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM installations').first<{ n: number }>())?.n).toBe(1)
  })

  it('does not invent missing snapshot history, but reconstructs first-seen installs', async () => {
    const { env } = await adminBindings()
    await clear(env.DB)
    await installation(env.DB, '11111111-1111-4111-8111-111111111111', 'packaged', '0.4.3', NOW - 10 * DAY, NOW, 2)
    const empty = await (await getAnalytics(new Request('https://example.test/v1/admin/analytics?range=14d'), env, NOW)).json<any>()
    expect(empty.history_available_from).toBeNull()
    expect(empty.current.active_24h).toBeNull()
    expect(empty.current.new_installs_period).toBe(1)
    expect(empty.daily_new_installs.reduce((sum: number, point: { count: number }) => sum + point.count, 0)).toBe(1)
    await collectAnalyticsSnapshot(env.DB, NOW)
    const result = await (await getAnalytics(new Request('https://example.test/v1/admin/analytics?range=14d'), env, NOW)).json<any>()
    expect(result.history_available_from).toBe(new Date(NOW).toISOString())
    expect(result.series).toHaveLength(1)
    expect(result.previous.active_24h).toBeNull()
    expect(result.current.launches_period).toBeNull()
  })

  it('uses last valid gauges for downsampling and rejects negative or gapped launch deltas', () => {
    const points = [0, 15, 30, 60].map((minute, index) => ({ bucket_ts: minute * 60_000, cumulative_launch_count: [3, 8, 6, 11][index], active_24h: index }))
    expect(sampleLatest(points, 60 * 60_000)).toEqual([points[2], points[3]])
    expect(launchDifferences(points, 15 * 60_000)).toEqual([5, null, null])
  })

  it('computes preceding equal-period installs and launches only from complete snapshots', async () => {
    const { env } = await adminBindings()
    await clear(env.DB)
    await installation(env.DB, '11111111-1111-4111-8111-111111111111', 'packaged', '0.4.2', NOW - 36 * 3_600_000, NOW, 3)
    await installation(env.DB, '22222222-2222-4222-8222-222222222222', 'packaged', '0.4.3', NOW - 12 * 3_600_000, NOW, 4)
    await env.DB.prepare(`
      WITH RECURSIVE ticks(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM ticks WHERE n < 192)
      INSERT INTO analytics_metric_snapshots (
        bucket_ts,cohort,collected_at,total_installations,active_24h,active_7d,active_30d,
        new_24h,new_7d,new_30d,cumulative_launch_count,average_launch_count,maximum_launch_count
      ) SELECT ? + n * 900000,'packaged',? + n * 900000,2,1,2,2,1,2,2,n * 2,1,2 FROM ticks
    `).bind(NOW - 2 * DAY, NOW - 2 * DAY).run()
    const result = await (await getAnalytics(new Request('https://example.test/v1/admin/analytics?range=24h'), env, NOW)).json<any>()
    expect(result.current.new_installs_period).toBe(1)
    expect(result.previous.new_installs_period).toBe(1)
    expect(result.current.launches_period).toBe(192)
    expect(result.previous.launches_period).toBe(192)
    expect(result.series).toHaveLength(97)
  })

  it('returns bounded 14-day metric and version series without exceeding D1 query limits', async () => {
    const { env } = await adminBindings()
    await clear(env.DB)
    await env.DB.prepare(`
      WITH RECURSIVE ticks(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM ticks WHERE n < 1344)
      INSERT INTO analytics_metric_snapshots (
        bucket_ts,cohort,collected_at,total_installations,active_24h,active_7d,active_30d,
        new_24h,new_7d,new_30d,cumulative_launch_count,average_launch_count,maximum_launch_count
      ) SELECT ? + n * 900000,'packaged',? + n * 900000,10,5,7,9,1,2,3,n,1,2 FROM ticks
    `).bind(NOW - 14 * DAY, NOW - 14 * DAY).run()
    await env.DB.prepare(`
      WITH RECURSIVE ticks(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM ticks WHERE n < 1344)
      INSERT INTO analytics_version_snapshots (bucket_ts,cohort,version,installation_count)
      SELECT ? + n * 900000,'packaged','0.4.3',8 FROM ticks
    `).bind(NOW - 14 * DAY).run()
    const result = await (await getAnalytics(new Request('https://example.test/v1/admin/analytics?range=14d'), env, NOW)).json<any>()
    expect(result.series.length).toBeGreaterThan(100)
    expect(result.series.length).toBeLessThan(200)
    expect(result.version_adoption[0].points).toHaveLength(result.series.length)
  })

  it('handles an empty installation database with a genuine zero snapshot', async () => {
    const { env } = await adminBindings()
    await clear(env.DB)
    await collectAnalyticsSnapshot(env.DB, NOW)
    const result = await (await getAnalytics(new Request('https://example.test/v1/admin/analytics'), env, NOW)).json<any>()
    expect(result.current.total_installations).toBe(0)
    expect(result.current_version_distribution).toEqual([])
    await env.DB.prepare("UPDATE analytics_metric_snapshots SET source = 'synthetic_local' WHERE cohort = 'packaged'").run()
    const oldDemo = await (await getAnalytics(new Request('https://example.test/v1/admin/analytics?range=24h'), env, NOW + 2 * DAY)).json<any>()
    expect(oldDemo.data_source).toBe('synthetic_local')
    expect(oldDemo.current.active_24h).toBeNull()
  })

  it('keeps analytics behind Access except for explicitly configured loopback development', async () => {
    const { env } = await adminBindings()
    const request = new Request('http://localhost:8787/v1/admin/analytics')
    expect((await adminWorker.fetch(request, env)).status).toBe(401)
    const local = { ...env, ENVIRONMENT: 'local', CONTROL_PANEL_ORIGIN: 'http://localhost:8787', ACCESS_AUD: 'configure-after-access-application-creation' } as unknown as AdminEnv
    expect((await adminWorker.fetch(request, local)).status).toBe(200)
    expect((await adminWorker.fetch(new Request('http://example.test/v1/admin/analytics'), local)).status).toBe(401)
  })
})
