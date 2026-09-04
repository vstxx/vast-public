const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const semver = require('semver')
const { readNoticesReleaseConfig } = require('./notices-release-config.cjs')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function flag(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

const channel = process.env.VAST_RELEASE_CHANNEL || 'dev'
const privateBuild = flag('VAST_PRIVATE_BUILD', true)
const publicDistribution = (channel === 'beta' || channel === 'stable') && !privateBuild
const publicUnsignedRelease = publicDistribution && flag('VAST_PUBLIC_UNSIGNED_RELEASE', false)
const signedPublicDistribution = publicDistribution && !publicUnsignedRelease
const configuredReleaseRepo = `${pkg.build?.publish?.owner ?? ''}/${pkg.build?.publish?.repo ?? ''}`
const releaseRepo = process.env.VAST_RELEASE_REPO || configuredReleaseRepo
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT ?? '').trim().toLowerCase()
const previousVersion = String(process.env.VAST_PREVIOUS_VERSION ?? '').trim()
const failures = []
const warnings = []
let notices = { enabled: false, feedOrigin: '', keyId: '' }

function requireConfig(condition, message) {
  if (!condition) failures.push(message)
}

function warnConfig(condition, message) {
  if (!condition) warnings.push(message)
}

requireConfig(pkg.productName === 'Vast', 'package productName must be Vast')
requireConfig(pkg.build?.appId === 'app.vast.browser', 'build.appId must be app.vast.browser')
requireConfig(pkg.build?.win?.signAndEditExecutable === true, 'Windows release builds must sign and edit executables')
requireConfig(pkg.build?.win?.signExecutable === true, 'Windows release builds must sign executables')
requireConfig(pkg.build?.forceCodeSigning === true, 'Windows public release builds must fail closed when signing is unavailable')
requireConfig(pkg.build?.publish?.owner !== 'YOUR_GITHUB_USERNAME', 'GitHub publish owner is still a placeholder')
requireConfig(pkg.build?.publish?.repo !== 'vast-browser', 'GitHub publish repo is still a placeholder')
requireConfig(pkg.build?.publish?.owner === 'vstxx' && pkg.build?.publish?.repo === 'vast-public', 'GitHub publish target must be vstxx/vast-public')
const protocolSchemes = (pkg.build?.protocols ?? []).flatMap((protocol) => protocol.schemes ?? [])
requireConfig(!protocolSchemes.includes('http') && !protocolSchemes.includes('https'), 'electron-builder protocols must not register http or https')

warnConfig(pkg.private === true, 'package should remain private to prevent accidental npm publish')
warnConfig(pkg.scripts?.dist?.includes('build:obfuscated'), 'dist should include the obfuscated build pipeline')

try {
  notices = readNoticesReleaseConfig(process.env)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
}

if (publicDistribution) {
  if (publicUnsignedRelease) {
    requireConfig(
      String(process.env.VAST_UNSIGNED_RELEASE_ACK ?? '').trim() === 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK',
      'public unsigned release requires VAST_UNSIGNED_RELEASE_ACK=I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
    )
  }
  if (signedPublicDistribution) {
    requireConfig(Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK), `signed public ${channel} build requires WIN_CSC_LINK or CSC_LINK`)
    requireConfig(Boolean(process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD), `signed public ${channel} build requires WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD`)
    requireConfig(Boolean(String(process.env.VAST_EXPECTED_SIGNER_SUBJECT ?? '').trim()), `signed public ${channel} build requires VAST_EXPECTED_SIGNER_SUBJECT`)
  }
  requireConfig(flag('VAST_UPDATE_ENABLED', false), `public ${channel} build requires VAST_UPDATE_ENABLED=1`)
  requireConfig(flag('VAST_OBFUSCATE', false), `public ${channel} build requires VAST_OBFUSCATE=1`)
  requireConfig(releaseRepo === 'vstxx/vast-public', `public ${channel} release artifacts must target vstxx/vast-public`)
  requireConfig(/^[a-f0-9]{40}$/.test(sourceCommit), `public ${channel} build requires VAST_RELEASE_COMMIT to be a full source commit SHA`)
  requireConfig(Boolean(semver.valid(previousVersion)), `public ${channel} build requires a valid VAST_PREVIOUS_VERSION`)
  requireConfig(Boolean(semver.valid(pkg.version)), 'package version must be valid SemVer')
  requireConfig(flag('VAST_RELAY_ENABLED', false), `public ${channel} requires VAST_RELAY_ENABLED=1`)
  requireConfig(String(process.env.VAST_RELAY_ENVIRONMENT ?? '').trim() === 'production', `public ${channel} requires VAST_RELAY_ENVIRONMENT=production`)
  if (semver.valid(previousVersion) && semver.valid(pkg.version)) {
    requireConfig(semver.lt(previousVersion, pkg.version), 'VAST_PREVIOUS_VERSION must be lower than package version')
  }
  requireConfig(channel !== 'beta' || semver.prerelease(pkg.version) !== null, 'public beta package version must contain a SemVer prerelease identifier')
  requireConfig(channel !== 'stable' || semver.prerelease(pkg.version) === null, 'public stable package version must not contain a SemVer prerelease identifier')

  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
  requireConfig(gitHead.status === 0, 'public distribution must be built from a Git commit')
  if (gitHead.status === 0 && /^[a-f0-9]{40}$/.test(sourceCommit)) {
    requireConfig(String(gitHead.stdout).trim().toLowerCase() === sourceCommit, 'VAST_RELEASE_COMMIT must match the checked-out HEAD')
  }
} else {
  warnConfig(!['beta', 'stable'].includes(channel) || privateBuild, `${channel} channel without public release env is treated as a private build`)
}

const report = {
  ok: failures.length === 0,
  version: pkg.version,
  channel,
  privateBuild,
  publicDistribution,
  publicUnsignedRelease,
  signaturePolicy: publicUnsignedRelease ? 'unsigned-public-release' : (signedPublicDistribution ? 'authenticode-signed' : 'private'),
  releaseRepo,
  sourceCommit,
  noticesEnabled: notices.enabled,
  noticesFeedOrigin: notices.feedOrigin,
  noticesKeyId: notices.keyId,
  failures,
  warnings
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exit(1)
