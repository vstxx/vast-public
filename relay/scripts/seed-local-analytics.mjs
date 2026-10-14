/** Synthetic visual fixture. This script can write only to Wrangler's isolated local demo D1. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv.slice(2).join(' ') !== '--demo') {
  throw new Error('Run with --demo to create an isolated local-only analytics fixture.')
}

const relay = join(dirname(fileURLToPath(import.meta.url)), '..')
const persist = join(relay, '.wrangler', 'analytics-demo')
const wrangler = join(relay, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const config = join(relay, 'admin', 'wrangler.jsonc')
const run = (args) => {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--local', '--config', config, '--persist-to', persist], {
    cwd: relay, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  })
  if (result.status !== 0) throw new Error(`Local Wrangler command failed: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
}

mkdirSync(persist, { recursive: true })
run(['d1', 'migrations', 'apply', 'DB'])

const DAY = 86_400_000
const BASE = 900_000
const now = Math.floor(Date.now() / BASE) * BASE
const start = now - 14 * DAY
const kinds = ['packaged', 'development', 'test', 'unknown']
const installations = Array.from({ length: 190 }, (_, index) => {
  const kind = index < 150 ? 'packaged' : index < 170 ? 'development' : index < 185 ? 'test' : 'unknown'
  const first = now - (28 - (index * 17 % 28)) * DAY + (index * 31 % 96) * BASE
  const last = now - (index * 13 % 40) * 3_600_000
  const version = index % 17 < 12 ? '0.4.3' : index % 17 < 16 ? '0.4.2' : '0.4.1'
  return { id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, kind, first, last: Math.max(first, last), version, launches: 3 + index % 12 }
})

const sql = [
  'DELETE FROM analytics_version_snapshots;',
  'DELETE FROM analytics_metric_snapshots;',
  'DELETE FROM installations;'
]
function insertRows(table, columns, rows) {
  for (let offset = 0; offset < rows.length; offset += 80) {
    sql.push(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${rows.slice(offset, offset + 80).map((row) => `(${row.map((value) => typeof value === 'string' ? `'${value}'` : value).join(',')})`).join(',')};`)
  }
}
insertRows('installations', ['install_id', 'current_version', 'first_seen', 'last_seen', 'launch_count', 'instance_kind'],
  installations.map((item) => [item.id, item.version, item.first, item.last, item.launches, item.kind]))

const metricRows = []
const versionRows = []
for (let bucket = start; bucket <= now; bucket += BASE) {
  const progress = (bucket - start) / (now - start)
  for (const cohort of ['all', ...kinds]) {
    const members = installations.filter((item) => (cohort === 'all' || item.kind === cohort) && item.first <= bucket)
    const total = members.length
    const wave = Math.round(5 * Math.sin((bucket - start) / DAY * Math.PI * 2))
    const active24 = Math.max(0, Math.min(total, Math.round(total * .58 + wave)))
    const active7 = Math.max(active24, Math.min(total, Math.round(total * .82)))
    const active30 = total
    const newly = (days) => members.filter((item) => item.first > bucket - days * DAY).length
    const factor = cohort === 'all' ? 1.45 : cohort === 'packaged' ? 1.1 : .14
    const launches = Math.round(total * 7 + (bucket - start) / BASE * factor + 18 * Math.floor((bucket - start) / DAY))
    const average = total ? Math.round(launches / total * 100) / 100 : 0
    metricRows.push([bucket, cohort, bucket, 'synthetic_local', total, active24, active7, active30, newly(1), newly(7), newly(30), launches, average, total ? Math.round(average * 2) : 0])
    if (total) {
      const latest = Math.floor(total * (.1 + .68 * progress))
      const oldest = Math.floor(total * Math.max(.02, .2 - .16 * progress))
      const middle = total - latest - oldest
      for (const [version, count] of [['0.4.3', latest], ['0.4.2', middle], ['0.4.1', oldest]]) {
        if (count > 0) versionRows.push([bucket, cohort, version, count])
      }
    }
  }
}
insertRows('analytics_metric_snapshots', [
  'bucket_ts', 'cohort', 'collected_at', 'source', 'total_installations', 'active_24h', 'active_7d', 'active_30d',
  'new_24h', 'new_7d', 'new_30d', 'cumulative_launch_count', 'average_launch_count', 'maximum_launch_count'
], metricRows)
insertRows('analytics_version_snapshots', ['bucket_ts', 'cohort', 'version', 'installation_count'], versionRows)

const fixture = join(persist, 'seed.sql')
writeFileSync(fixture, sql.join('\n'))
run(['d1', 'execute', 'DB', '--file', fixture])
console.log(`Synthetic local fixture: ${installations.length} installations, ${metricRows.length} metric snapshots, ${versionRows.length} version rows.`)
console.log(`Saved only to ${persist}. Start Wrangler with --persist-to "${persist}".`)
