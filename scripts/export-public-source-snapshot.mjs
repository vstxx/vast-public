import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputIndex = process.argv.indexOf('--output')
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT || '').trim().toLowerCase()
const worktree = process.argv.includes('--worktree')
if (!outputArgument || !isAbsolute(outputArgument)) throw new Error('--output must be an absolute path outside the source repository.')
const output = resolve(outputArgument)
if (output === root || output.startsWith(`${root}${sep}`)) throw new Error('Public source output must be outside the source repository.')
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('VAST_RELEASE_COMMIT must be a full commit SHA.')

const commitCheck = spawnSync('git', ['rev-parse', `${sourceCommit}^{commit}`], { cwd: root, encoding: 'utf8' })
if (commitCheck.status !== 0 || commitCheck.stdout.trim().toLowerCase() !== sourceCommit) throw new Error('VAST_RELEASE_COMMIT is not an available source commit.')
const tracked = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', sourceCommit], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (tracked.status !== 0) throw new Error('Could not enumerate the release source tree.')

const excluded = [
  /^audit\//,
  /^docs\/PRODUCTION_CORRECTNESS_AUDIT\.md$/,
  /^docs\/STORE_ICONS_AND_MENUS_PASS\.md$/,
  /^\.github\/workflows\/hub-staging-edge\.yml$/,
  /^artifacts\//,
  /^resources\/first-party-extensions\/idu-plus\//,
  /^docs\/GIT_HISTORY_PRIVACY_REWRITE\.md$/,
  /^relay\/keys\/staging-verification\.json$/,
  /^scripts\/release-audit\.cjs$/,
  /^tests\/renderer\/release-hardening-scripts\.test\.ts$/,
  /^docs\/FINAL_POLISH_REPORT\.md$/,
  /^docs\/OPEN_SOURCE_READINESS\.md$/,
  /^docs\/PERFORMANCE_AUDIT\.md$/,
  /^docs\/DISTRIBUTION_SIZE_OPTIMIZATION\.md$/,
  /^docs\/IDU_PLUS_HUB_PUBLISHING\.md$/,
  /^docs\/MICROSOFT_STORE_SUBMISSION\.md$/,
  /^docs\/SIGNED_RELEASE_TUTORIAL\.md$/,
  /^docs\/VAST_RELAY_OPERATIONS\.md$/,
  /^docs\/SQLITE_MIGRATION_PLAN\.md$/,
  /^docs\/DEFAULT_WORKSPACE_ONBOARDING_SPEC\.md$/,
  /^docs\/RELEASE_\d+\.\d+\.\d+_(?:READINESS|PREREQUISITES)\.md$/,
  /^docs\/google-auth\//,
  /^docs\/releases\//,
  /^docs\/chromium-migration\/(?:CHECKPOINT|progress)\.md$/
]

if (existsSync(output)) throw new Error('Snapshot output must not already exist; choose a new empty destination.')
mkdirSync(output, { recursive: true })
const workingFiles = worktree ? spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) : tracked
if (workingFiles.status !== 0) throw new Error('Could not enumerate source files.')
for (const path of new Set(workingFiles.stdout.split('\0').filter(Boolean))) {
  const normalized = path.replaceAll('\\', '/')
  if (excluded.some((pattern) => pattern.test(normalized))) continue
  if (worktree && !existsSync(join(root, normalized))) continue
  if (worktree && lstatSync(join(root, normalized)).isSymbolicLink()) throw new Error(`Snapshot input must not be a symlink: ${normalized}`)
  const target = join(output, ...normalized.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  const contents = worktree ? { status: 0, stdout: readFileSync(join(root, normalized)) } : spawnSync('git', ['show', `${sourceCommit}:${normalized}`], { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 })
  if (contents.status !== 0) throw new Error(`Could not export tracked source file: ${normalized}`)
  writeFileSync(target, contents.stdout)
}

const publicCiPath = join(output, '.github', 'workflows', 'windows-ci.yml')
if (existsSync(publicCiPath)) {
  const publicCi = readFileSync(publicCiPath, 'utf8')
  const normalizedCi = publicCi.replace('branches: [master]', 'branches: [main]')
  if (normalizedCi === publicCi) throw new Error('Public Windows CI branch normalization did not find the expected private branch trigger.')
  writeFileSync(publicCiPath, normalizedCi)
}

const publicPackagePath = join(output, 'package.json')
if (!existsSync(publicPackagePath)) throw new Error('Exported public source does not contain package.json.')
const publicPackage = JSON.parse(readFileSync(publicPackagePath, 'utf8'))
if (publicPackage.scripts?.['release:audit'] !== 'node scripts/release-audit.cjs') {
  throw new Error('Public release:audit mapping does not match the expected canonical script.')
}
publicPackage.scripts['release:audit'] = 'node scripts/public-release-audit.cjs'
writeFileSync(publicPackagePath, `${JSON.stringify(publicPackage, null, 2)}\n`)

writeFileSync(join(output, '.vast-source-provenance.json'), `${JSON.stringify({
  schema: 2,
  version: publicPackage.version,
  sourceCommit,
  worktreePreview: worktree,
  exportedAt: new Date().toISOString(),
  exclusions: excluded.map(String),
  transformations: [
    '.github/workflows/windows-ci.yml: private master push trigger normalized to public main',
    'package.json: release:audit mapped to the public snapshot audit'
  ]
}, null, 2)}\n`)
for (const args of [[join(output, 'scripts/public-release-audit.cjs')], [join(root, 'scripts/secret-scan.cjs'), output]]) {
  const check = spawnSync(process.execPath, args, { cwd: output, stdio: 'inherit', windowsHide: true })
  if (check.error || check.status !== 0) throw new Error('Generated public snapshot failed audit/secret scan; publication is forbidden.')
}
console.log(JSON.stringify({ ok: true, output, version: publicPackage.version, sourceCommit }))
