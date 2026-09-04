const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const {
  STORE_POLICY_REVIEWED_AT,
  STORE_POLICY_REVIEW_MAX_AGE_DAYS,
  identityFromEnv,
  manifestXml,
  msixVersionForSemver,
  root
} = require('./store-msix-config.cjs')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const failures = []
const networkChecks = process.env.VAST_STORE_SKIP_NETWORK_CHECKS !== '1'

function requireGate(condition, message) {
  if (!condition) failures.push(message)
}

function run(command, args, label, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, shell: false })
  if (result.error || result.status !== 0) {
    failures.push(`${label}: ${String(result.stderr || result.stdout || result.error?.message || 'failed').trim()}`)
  }
  return result
}

requireGate(pkg.version === '0.2.7', `package.json must be 0.2.7, received ${pkg.version}`)
requireGate(lock.version === pkg.version && lock.packages?.['']?.version === pkg.version, 'package-lock root version must match package.json')
requireGate(pkg.devDependencies?.electron === '44.1.0', 'Electron must be pinned exactly to 44.1.0')
requireGate(lock.packages?.['node_modules/electron']?.version === '44.1.0', 'package-lock must resolve Electron 44.1.0')
requireGate(process.env.VAST_DISTRIBUTION_CHANNEL === 'microsoft-store', 'VAST_DISTRIBUTION_CHANNEL must be microsoft-store')
requireGate(String(process.env.VAST_UPDATE_ENABLED ?? '') === '0', 'VAST_UPDATE_ENABLED must be 0 for Store')
requireGate(String(process.env.VAST_PRIVATE_BUILD ?? '') === '0', 'VAST_PRIVATE_BUILD must be 0 for production Store packaging')
requireGate(String(process.env.VAST_OBFUSCATE ?? '') === '1', 'VAST_OBFUSCATE must be 1 for production Store packaging')
requireGate(['beta', 'stable'].includes(String(process.env.VAST_RELEASE_CHANNEL ?? '')), 'VAST_RELEASE_CHANNEL must be beta or stable')
requireGate(String(process.env.VAST_RELAY_ENVIRONMENT ?? '') === 'production', 'VAST_RELAY_ENVIRONMENT must be production')
requireGate(String(process.env.VAST_RELAY_ENABLED ?? '') === '1', 'VAST_RELAY_ENABLED must be 1')
let identity
try {
  identity = identityFromEnv(process.env, false)
  manifestXml(identity, pkg.version)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
}

const reviewAgeDays = Math.floor((Date.now() - Date.parse(`${STORE_POLICY_REVIEWED_AT}T00:00:00Z`)) / 86_400_000)
requireGate(reviewAgeDays >= 0 && reviewAgeDays <= STORE_POLICY_REVIEW_MAX_AGE_DAYS,
  `Microsoft Store policy review is stale (${STORE_POLICY_REVIEWED_AT}); review current policy before packaging`)

const headResult = run('git', ['rev-parse', 'HEAD'], 'could not resolve final Git SHA')
const head = String(headResult.stdout || '').trim().toLowerCase()
requireGate(/^[a-f0-9]{40}$/.test(head), 'production Store package requires a full Git SHA')
requireGate(String(process.env.VAST_RELEASE_COMMIT ?? '').trim().toLowerCase() === head, 'VAST_RELEASE_COMMIT must match HEAD')
const status = run('git', ['status', '--porcelain', '--untracked-files=all'], 'could not inspect worktree')
const dirtyWorktree = String(status.stdout || '').trim().split(/\r?\n/).filter(Boolean)
requireGate(dirtyWorktree.length === 0, `production Store package requires a clean worktree${dirtyWorktree.length ? `: ${dirtyWorktree.slice(0, 20).join(', ')}` : ''}`)

run(process.execPath, ['scripts/verify-electron-version.cjs'], 'Electron runtime gate')
run(process.execPath, ['scripts/check-store-browser-recency.cjs'], 'browser recency policy gate')

if (networkChecks) {
  run(process.execPath, ['scripts/verify-hub-production-readiness.mjs'], 'production Hub readiness gate')
} else {
  failures.push('VAST_STORE_SKIP_NETWORK_CHECKS=1 is not allowed for a production Store release gate')
}

const report = {
  ok: failures.length === 0,
  productVersion: pkg.version,
  msixVersion: msixVersionForSemver(pkg.version),
  electron: pkg.devDependencies.electron,
  sourceCommit: head || null,
  identity: identity ? { name: identity.name, publisher: identity.publisher, publisherDisplayName: identity.publisherDisplayName } : null,
  policyReviewedAt: STORE_POLICY_REVIEWED_AT,
  networkChecks,
  failures
}
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exit(1)
