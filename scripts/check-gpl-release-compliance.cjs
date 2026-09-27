const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const failures = []
const checks = []

function read(relativePath) {
  return readFileSync(join(root, relativePath))
}

function text(relativePath) {
  return read(relativePath).toString('utf8')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function check(name, condition, detail) {
  const pass = Boolean(condition)
  checks.push({ name, pass, detail })
  if (!pass) failures.push(`${name}: ${detail}`)
}

const pkg = JSON.parse(text('package.json'))
const lock = JSON.parse(text('package-lock.json'))
const eceLock = JSON.parse(text('experiments/electron-chrome-extensions-4.9.0/upstream-lock.json'))
const compatibilityManifest = JSON.parse(text('patches/extension-compatibility-runtime.json'))
const eceVersion = pkg.dependencies?.['electron-chrome-extensions'] ?? pkg.devDependencies?.['electron-chrome-extensions']
const extraResources = pkg.build?.extraResources ?? []
const hasResource = (from, to) => extraResources.some((entry) => entry.from === from && entry.to === to)

check('Vast SPDX license', pkg.license === 'GPL-3.0-only', 'package.json must declare GPL-3.0-only')
check('lockfile root license', lock.packages?.['']?.license === 'GPL-3.0-only', 'package-lock root package must declare GPL-3.0-only')
check('canonical GPL text', read('LICENSE').equals(read('node_modules/electron-chrome-extensions/LICENSE-GPL')), 'root LICENSE must match the canonical GPLv3 text shipped by ECE')
check('ECE exact version', eceVersion === '4.9.0', 'electron-chrome-extensions must be pinned exactly to 4.9.0')
check('ECE npm integrity', lock.packages?.['node_modules/electron-chrome-extensions']?.integrity === eceLock.npmIntegrity, 'locked ECE tarball integrity must match the reviewed upstream package')
check('ECE GPL selection', /const ECE_GPL_LICENSE = 'GPL-3\.0'/.test(text('src/main/extensions/extension-compatibility-runtime.ts')), 'runtime must select ECE GPL-3.0 explicitly')
check('no configurable ECE license path', !/VAST_ECE_LICENSE|ECE_PATRON_LICENSE/.test(text('src/main/extensions/extension-compatibility-runtime.ts') + text('scripts/dev-extension-compat.cjs')), 'runtime licensing must not be switched to Patron/commercial by environment')
check('Vast license packaged', hasResource('LICENSE', 'licenses/Vast-GPL-3.0.txt'), 'packaged resources must contain Vast GPL text')
check('third-party notices packaged', hasResource('THIRD_PARTY_NOTICES.md', 'licenses/THIRD_PARTY_NOTICES.md'), 'packaged resources must contain third-party notices')
check('ECE GPL text packaged', hasResource('node_modules/electron-chrome-extensions/LICENSE-GPL', 'licenses/electron-chrome-extensions-GPL-3.0.txt'), 'packaged resources must contain ECE GPL text')
check('ECE source base pinned', eceLock.commit === '927ac340c3c6cc462f636a50ccd9991df0cd2e12' && eceLock.version === '4.9.0', 'ECE preferred source must name the exact upstream release commit')

const ecePatchPath = 'experiments/electron-chrome-extensions-4.9.0/0001-vast-browser-compatibility.patch'
check('ECE source patch exists', existsSync(join(root, ecePatchPath)), 'preferred TypeScript source patch must be published')
if (existsSync(join(root, ecePatchPath))) {
  check('ECE source patch integrity', sha256(read(ecePatchPath)) === eceLock.patchSha256, 'ECE source patch SHA-256 must match upstream-lock.json')
}

for (const entry of compatibilityManifest.electron.patches) {
  const patch = entry.path
  check(`Electron patch published: ${patch}`, existsSync(join(root, patch)) && read(patch).length > 0, 'matching native source patch is required')
  if (existsSync(join(root, patch))) {
    check(`Electron patch fingerprint: ${patch}`, sha256(read(patch)) === entry.sha256, 'published native source patch must match the approved runtime manifest')
  }
}

for (const document of ['README.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE.md', 'docs/OPEN_SOURCE_LICENSE_AUDIT.md']) {
  check(`GPL documentation: ${document}`, /GPL-3\.0/.test(text(document)), `${document} must state the GPL-3.0 licensing path`)
}

const report = {
  ok: failures.length === 0,
  vastLicense: pkg.license,
  ece: {
    version: eceVersion,
    license: 'GPL-3.0',
    upstreamCommit: eceLock.commit,
    patchSha256: eceLock.patchSha256
  },
  checks,
  failures
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

module.exports = { report }
