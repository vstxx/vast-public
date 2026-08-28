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
requireEqual('public beta workflow expected_version', capture(workflow, /expected_version:[\s\S]*?default:\s*([^\s#]+)/, 'workflow version'))
requireEqual('signed public workflow expected_version', capture(signedWorkflow, /expected_version:[\s\S]*?default:\s*([^\s#]+)/, 'signed workflow version'))
requireEqual('updater bootstrapper default', capture(bootstrapper, /\[string\]\s*\$Version\s*=\s*'([^']+)'/, 'bootstrapper version'))
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

if (!/^0\.2\.5$/.test(pkg.version)) failures.push(`0.2.5 release branch expected, found ${pkg.version}`)
if (!/VAST_PREVIOUS_VERSION:\s*0\.1\.5\b/.test(workflow)) failures.push('public beta workflow must use real previous public version 0.1.5')

console.log(JSON.stringify({ ok: failures.length === 0, version: pkg.version, previousPublicVersion: '0.1.5', artifactTokens, failures }, null, 2))
if (failures.length) process.exit(1)
