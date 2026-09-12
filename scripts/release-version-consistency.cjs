const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const workflow = readFileSync(join(root, '.github', 'workflows', 'public-unsigned-beta.yml'), 'utf8')
const signedWorkflow = readFileSync(join(root, '.github', 'workflows', 'public-release.yml'), 'utf8')
const bootstrapper = readFileSync(join(root, 'scripts', 'build-updater-bootstrapper.ps1'), 'utf8')
const updaterConfig = JSON.parse(readFileSync(join(root, 'resources', 'updater', 'updater.config.json'), 'utf8').replace(/^\uFEFF/, ''))
const buildMetadataWriter = readFileSync(join(root, 'scripts', 'write-release-build-metadata.cjs'), 'utf8')
const packageVerifier = readFileSync(join(root, 'scripts', 'verify-release-package.cjs'), 'utf8')
const failures = []
const config = require('./release-config.json')
const semver = require('semver')
const storeWorkflow = readFileSync(join(root, '.github/workflows/store-release.yml'), 'utf8')

function requireEqual(label, actual, expected = pkg.version) {
  if (actual !== expected) failures.push(`${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`)
}

function capture(source, expression, label) {
  const match = expression.exec(source)
  if (!match) {
    failures.push(`${label} declaration was not found`)
    return undefined
  }
  return match[1]
}

requireEqual('package-lock root version', lock.version)
requireEqual('package-lock package version', lock.packages?.['']?.version)
requireEqual('public unsigned workflow expected_version', capture(workflow, /expected_version:[\s\S]*?default:\s*([^\s#]+)/, 'workflow version'))
requireEqual('signed public workflow expected_version', capture(signedWorkflow, /expected_version:[\s\S]*?default:\s*([^\s#]+)/, 'signed workflow version'))
if (!bootstrapper.includes("'package.json') | ConvertFrom-Json).version")) failures.push('bootstrapper must derive its default from package.json')
requireEqual('canonical updater targetVersion', updaterConfig.targetVersion)
requireEqual('canonical updater payloadPath', updaterConfig.payloadPath, `..\\Vast-${pkg.version}\\win-unpacked`)
if (!buildMetadataWriter.includes('version: pkg.version')) failures.push('release metadata must derive version from package.json')
for (const template of ['Vast-Setup-${version}.${ext}', 'Vast-${version}-Portable.${ext}']) {
  if (!JSON.stringify(pkg.build).includes(template)) failures.push(`builder artifact template is missing: ${template}`)
}
for (const template of ['Vast-Setup-${version}.exe', 'VastUpdater-${version}.exe', 'Vast-${version}-update.zip']) {
  if (!packageVerifier.includes(template)) failures.push(`release package verifier template is missing: ${template}`)
}

const artifactTokens = [
  `Vast-Setup-${pkg.version}.exe`,
  `Vast-${pkg.version}-Portable.exe`,
  `VastUpdater-${pkg.version}.exe`,
  `Vast-${pkg.version}-update.zip`
]
for (const token of artifactTokens) {
  if (!token.includes(pkg.version)) failures.push(`artifact token is inconsistent: ${token}`)
}

if (!semver.valid(pkg.version) || !semver.gt(pkg.version, config.previousPublicVersion)) failures.push('Product version must exceed the previous public release')
requireEqual('unsigned workflow baseline', capture(workflow, /VAST_PREVIOUS_VERSION:\s*([^\s]+)/, 'baseline'), config.previousPublicVersion)
requireEqual('signed workflow baseline', capture(signedWorkflow, /previous_version:[\s\S]*?default:\s*([^\s#]+)/, 'signed baseline'), config.previousPublicVersion)
requireEqual('Store workflow product version', capture(storeWorkflow, /expected_version:[\s\S]*?default:\s*([^\s#]+)/, 'Store product version'))
requireEqual('Store workflow package version', capture(storeWorkflow, /store_package_version:[\s\S]*?default:\s*([^\s#]+)/, 'Store package version'), config.storePackageVersion)
requireEqual('Store workflow previous package version', capture(storeWorkflow, /previous_store_package_version:[\s\S]*?default:\s*([^\s#]+)/, 'Store baseline'), config.previousStorePackageVersion)
for (const [label, source] of [['signed', signedWorkflow], ['unsigned', workflow]]) {
  if (!source.includes(`https://github.com/vstxx/vast-public/releases/download/v${config.previousPublicVersion}`)) failures.push(`${label} baseline URL differs from release-config.json`)
}
require('./store-msix-config.cjs').storePackageVersion()

console.log(JSON.stringify({ ok: failures.length === 0, version: pkg.version, previousPublicVersion: config.previousPublicVersion, artifactTokens, failures }, null, 2))
if (failures.length) process.exit(1)
