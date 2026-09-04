import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv[process.argv.indexOf('--output') + 1]
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT || '').trim().toLowerCase()
if (!outputArgument || !isAbsolute(outputArgument)) throw new Error('--output must be an absolute path outside the source repository.')
const output = resolve(outputArgument)
if (output === root || output.startsWith(`${root}${sep}`)) throw new Error('Public source output must be outside the source repository.')
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('VAST_RELEASE_COMMIT must be a full commit SHA.')

const commitCheck = spawnSync('git', ['rev-parse', `${sourceCommit}^{commit}`], { cwd: root, encoding: 'utf8' })
if (commitCheck.status !== 0 || commitCheck.stdout.trim().toLowerCase() !== sourceCommit) throw new Error('VAST_RELEASE_COMMIT is not an available source commit.')
const tracked = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', sourceCommit], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (tracked.status !== 0) throw new Error('Could not enumerate the release source tree.')

const excluded = [
  /^\.github\/workflows\/hub-staging-edge\.yml$/,
  /^artifacts\//,
  /^resources\/first-party-extensions\/idu-plus\//,
  /^docs\/GIT_HISTORY_PRIVACY_REWRITE\.md$/,
  /^relay\/keys\/staging-verification\.json$/
]

if (existsSync(output)) rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
for (const path of tracked.stdout.split('\0').filter(Boolean)) {
  const normalized = path.replaceAll('\\', '/')
  if (excluded.some((pattern) => pattern.test(normalized))) continue
  const target = join(output, ...normalized.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  const contents = spawnSync('git', ['show', `${sourceCommit}:${normalized}`], { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 })
  if (contents.status !== 0) throw new Error(`Could not export tracked source file: ${normalized}`)
  writeFileSync(target, contents.stdout)
}
const packageResult = spawnSync('git', ['show', `${sourceCommit}:package.json`], { cwd: root, encoding: 'utf8' })
if (packageResult.status !== 0) throw new Error('Release source does not contain package.json.')
const pkg = JSON.parse(packageResult.stdout)
writeFileSync(join(output, '.vast-source-provenance.json'), `${JSON.stringify({ schema: 1, version: pkg.version, sourceCommit, exportedAt: new Date().toISOString(), exclusions: excluded.map(String) }, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, output, version: pkg.version, sourceCommit }))
