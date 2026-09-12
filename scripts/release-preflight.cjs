// Local verification only: no release builder, deployment, installer, tags or pushes.
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const root = join(__dirname, '..')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run npm run release:preflight so the active npm CLI is used.')
const env = { ...process.env, VAST_RELEASE_CHANNEL: 'dev', VAST_PRIVATE_BUILD: '1', VAST_DISTRIBUTION_CHANNEL: 'direct', VAST_PUBLIC_UNSIGNED_RELEASE: '0', VAST_UPDATE_ENABLED: '0', VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1' }
delete env.ELECTRON_RUN_AS_NODE
const directory = join(root, '.vast-build', 'release-preflight')
mkdirSync(directory, { recursive: true })
const results = []
function run(label, args) {
  console.log(`\n[preflight] ${label}`)
  const started = Date.now()
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000, windowsHide: true })
  const log = join(directory, `${results.length + 1}-${label.replace(/[^a-z0-9-]/gi, '-')}.log`)
  writeFileSync(log, (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''))
  const ok = !result.error && result.status === 0
  results.push({ command: label, status: ok ? 'PASS' : 'FAIL', seconds: (Date.now() - started) / 1000, log })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${log}`)
  if (!ok) console.error(((result.stderr || result.stdout || result.error?.message || '')).slice(-2500))
  return ok
}
for (const script of ['release:version-check', 'audit:ci', 'lint', 'test', 'test:store', 'test:release']) run(`npm run ${script}`, [npm, 'run', script])
run('npm run check --prefix relay', [npm, 'run', 'check', '--prefix', 'relay'])
run('npm run build:signer --prefix extensions-hub', [npm, 'run', 'build:signer', '--prefix', 'extensions-hub'])
for (const script of ['hub:typecheck', 'hub:test', 'hub:build', 'extension:adblock:typecheck', 'test:electron-version', 'updater:stage', 'test:updater', 'test:fuses:integration', 'release:audit', 'test:extensions:e2e', 'test:extensions:native-e2e', 'test:adblock:extension-e2e', 'test:app', 'test:updater:background', 'build:obfuscated']) run(`npm run ${script}`, [npm, 'run', script])
run('node scripts/secret-scan.cjs', [join(root, 'scripts/secret-scan.cjs')])
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
env.VAST_RELEASE_COMMIT = head.stdout.trim()
const snapshot = join(mkdtempSync(join(tmpdir(), 'vast-public-preflight-')), 'snapshot')
run('public snapshot export + audit + secret scan (worktree preview)', [join(root, 'scripts/export-public-source-snapshot.mjs'), '--output', snapshot, '--worktree'])
const manual = [
  'Commit the reviewed changes; run preflight again on the clean final SHA before dispatch.',
  'Verify Partner Center highest consumed package version and update Store inputs; run WACK and isolated elevated install/upgrade/uninstall checks.',
  'Signing credentials, production Relay synthetic writes and Hub production trust verification remain protected release-workflow gates.',
  'Final signed/MSIX artifact size, package integrity and real 0.2.7 upgrade gates require a built release candidate; local preflight does not create or install one.'
]
const report = { version: require('../package.json').version, sourceCommit: env.VAST_RELEASE_COMMIT, results, manual, snapshot }
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.table(results.map(({ command, status, seconds }) => ({ command, status, seconds })))
for (const item of manual) console.log(`MANUAL/EXTERNAL: ${item}`)
process.exitCode = results.some(result => result.status === 'FAIL') ? 1 : 0
