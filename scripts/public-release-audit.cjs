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
    } else {
      fail(`unsupported link or special file: ${absolutePath}`)
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

for (const path of ['scripts/release-audit.cjs', 'tests/renderer/release-hardening-scripts.test.ts']) {
  assert(!existsSync(join(root, path)), `canonical-only release internals leaked into public source: ${path}`)
}

const docs = walk('docs')
// Path checks cover the entire snapshot, including newly introduced directories.
for (const path of walk('')) {
  assert(!/(^|\/)(?:audit|secrets|node_modules|\.git|\.wrangler|\.vast-build|\.vast-test-artifacts|performance-results|preview-screenshots|user-data|User Data|Default|Profile \d+)(\/|$)/i.test(path), `private directory in snapshot: ${path}`)
  assert(!/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars|password-vault\.json|Cookies|Login Data|Web Data|Local State|release\.zip.*)$/i.test(path) || /\.example$/.test(path), `private configuration/profile in snapshot: ${path}`)
  assert(!/(^|\/)(?:local-proofs\.cjs|read-coverage\.json|architecture-notes\.md|fixture-92A6Z9)(\/|$)/i.test(path), `internal audit proof in snapshot: ${path}`)
  assert(!/\.(?:pem|key|p8|pk8|pfx|p12|crt|cer|p7b|p7c|log|dmp|msix|exe|tmp|bak)$/i.test(path), `private key, certificate or generated artifact in snapshot: ${path}`)
  const contents = readFileSync(join(root, path))
  if (!contents.includes(0)) {
    const text = contents.toString('utf8')
    assert(!/^-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----\r?$/m.test(text), `private key/certificate material in snapshot: ${path}`)
    assert(!/(?:[A-Z]:[\\/]+Users[\\/]+jnowa|D:[\\/]+All Side Files|\/Users\/jnowa|\/home\/jnowa)/i.test(text), `private workstation path in snapshot: ${path}`)
  }
}
for (const path of ['audit', '.gitleaksignore', 'release-candidate.json', 'release', 'out']) {
  assert(!existsSync(join(root, path)), `private release/scan artifact in snapshot: ${path}`)
}
const forbidden = [
  /^docs\/PRODUCTION_CORRECTNESS_AUDIT\.md$/,
  /^docs\/STORE_ICONS_AND_MENUS_PASS\.md$/,
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
