const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { join, relative } = require('node:path')

const root = join(__dirname, '..')
const fail = (message) => { throw new Error(`Public source audit failed: ${message}`) }
const assert = (condition, message) => { if (!condition) fail(message) }
const read = (path) => readFileSync(join(root, path), 'utf8')

const walk = (relativeDir) => {
  const absoluteDir = join(root, relativeDir)
  if (!existsSync(absoluteDir)) return []
  const files = []
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = join(absoluteDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(relative(root, absolutePath).replaceAll('\\', '/')))
    } else if (entry.isFile()) {
      files.push(relative(root, absolutePath).replaceAll('\\', '/'))
    }
  }
  return files
}

const required = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'RELEASE.md',
  'ROADMAP.md',
  '.vast-source-provenance.json',
  '.github/workflows/windows-ci.yml',
  'docs/README.md',
  'docs/PRIVACY.md',
  'docs/FEATURE_STATUS.md',
  'docs/SECURITY_ARCHITECTURE.md',
  'docs/IPC_SECURITY.md',
  'docs/OPEN_SOURCE_LICENSE_AUDIT.md',
  'docs/RELEASE_CHECKLIST.md'
]

for (const path of required) assert(existsSync(join(root, path)), `required public file is missing: ${path}`)

const docs = walk('docs')
const forbidden = [
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

for (const path of docs) {
  assert(!forbidden.some((pattern) => pattern.test(path)), `internal or historical worklog leaked into public docs: ${path}`)
}

const readme = read('README.md')
for (const stale of ['OPEN_SOURCE_READINESS', 'before making a repository public', '1.0.11', '1.0.9']) {
  assert(!readme.includes(stale), `README contains stale public-facing text: ${stale}`)
}
assert(readme.includes('https://vastbrowser.com'), 'README must link to the Vast Browser website')
assert(readme.includes('## Public source model'), 'README must explain the public source snapshot model')

const security = read('SECURITY.md')
assert(!/before the repository is made public/i.test(security), 'SECURITY.md still contains pre-publication instructions')
assert(security.includes('docs/SECURITY_ARCHITECTURE.md'), 'SECURITY.md must link to the maintained architecture document')

const workflow = read('.github/workflows/windows-ci.yml')
assert(workflow.includes('branches: [main]'), 'public Windows CI must target main')
assert(!workflow.includes('branches: [master]'), 'private master branch trigger leaked into public Windows CI')
assert(workflow.includes('paths-ignore:'), 'public Windows CI should skip documentation-only changes')
assert(workflow.includes("if: github.event_name != 'pull_request'"), 'expensive packaging should not run on ordinary pull requests')

const pkg = JSON.parse(read('package.json'))
assert(pkg.repository?.url === 'git+https://github.com/vstxx/vast-public.git', 'package repository metadata must point to vast-public')
assert(pkg.homepage === 'https://vastbrowser.com', 'package homepage must point to vastbrowser.com')
assert(pkg.scripts?.['release:audit'] === 'node scripts/public-release-audit.cjs', 'public release:audit must use the public snapshot audit')

const provenance = JSON.parse(read('.vast-source-provenance.json'))
assert(Number.isInteger(provenance.schema) && provenance.schema >= 1, 'source provenance schema is invalid')
assert(provenance.version === pkg.version, 'source provenance version does not match package.json')
assert(/^[a-f0-9]{40}$/i.test(String(provenance.sourceCommit || '')), 'source provenance must contain a full canonical commit SHA')
assert(Array.isArray(provenance.exclusions), 'source provenance must record intentional exclusions')

console.log(`Public source audit passed for Vast ${pkg.version}.`)
