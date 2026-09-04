const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { readNoticesReleaseConfig } = require('./notices-release-config.cjs')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outputPath = join(root, 'out', 'release-build-metadata.json')

function flag(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

const releaseChannel = String(process.env.VAST_RELEASE_CHANNEL ?? 'dev').trim() || 'dev'
const distributionChannel = String(process.env.VAST_DISTRIBUTION_CHANNEL ?? 'direct').trim() || 'direct'
const privateBuild = flag('VAST_PRIVATE_BUILD', true)
const updateEnabled = flag('VAST_UPDATE_ENABLED', false)
const obfuscationEnabled = flag('VAST_OBFUSCATE', false)
const releaseRepo = String(process.env.VAST_RELEASE_REPO ?? 'vstxx/vast-public').trim() || 'vstxx/vast-public'
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT ?? '').trim().toLowerCase()
const publicDistribution = (releaseChannel === 'beta' || releaseChannel === 'stable') && !privateBuild
const publicUnsignedRelease = publicDistribution && flag('VAST_PUBLIC_UNSIGNED_RELEASE', false)
const requestedRelayEnvironment = String(process.env.VAST_RELAY_ENVIRONMENT ?? '').trim().toLowerCase()
const relayEnvironment = requestedRelayEnvironment || ((releaseChannel === 'beta' || releaseChannel === 'stable') ? 'production' : 'staging')
const relayEnabled = flag('VAST_RELAY_ENABLED', true)
const relayEndpoint = relayEnvironment === 'production'
  ? 'https://relay.vastbrowser.com'
  : 'https://relay-staging.vastbrowser.com'
const relayKeyId = relayEnvironment === 'production' ? 'relay-2026-01' : 'relay-staging-2026-01'
const signaturePolicy = distributionChannel === 'microsoft-store'
  ? 'microsoft-store-submission'
  : publicUnsignedRelease
    ? 'unsigned-public-release'
    : (publicDistribution ? 'authenticode-signed' : 'internal-unsigned')
const failures = []
let notices = { enabled: false, feedOrigin: '', keyId: '' }

function requireConfig(condition, message) {
  if (!condition) failures.push(message)
}

try {
  notices = readNoticesReleaseConfig(process.env)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
}

requireConfig(['direct', 'microsoft-store'].includes(distributionChannel), 'VAST_DISTRIBUTION_CHANNEL must be direct or microsoft-store')
requireConfig(distributionChannel === 'direct' || !flag('VAST_PUBLIC_UNSIGNED_RELEASE', false), 'VAST_PUBLIC_UNSIGNED_RELEASE is not valid for Microsoft Store packages')

if (publicDistribution) {
  requireConfig(
    distributionChannel === 'microsoft-store' ? !updateEnabled : updateEnabled,
    `public ${releaseChannel} ${distributionChannel} metadata requires VAST_UPDATE_ENABLED=${distributionChannel === 'microsoft-store' ? '0' : '1'}`
  )
  requireConfig(obfuscationEnabled, `public ${releaseChannel} release metadata requires VAST_OBFUSCATE=1`)
  requireConfig(releaseRepo === 'vstxx/vast-public', `public ${releaseChannel} release metadata requires VAST_RELEASE_REPO=vstxx/vast-public`)
  requireConfig(/^[a-f0-9]{40}$/.test(sourceCommit), `public ${releaseChannel} release metadata requires a full VAST_RELEASE_COMMIT SHA`)
  if (publicUnsignedRelease) {
    requireConfig(
      String(process.env.VAST_UNSIGNED_RELEASE_ACK ?? '').trim() === 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK',
      'public unsigned release metadata requires the explicit risk acknowledgement'
    )
  }
  requireConfig(relayEnabled, `public ${releaseChannel} metadata requires VAST_RELAY_ENABLED=1`)
  requireConfig(relayEnvironment === 'production', `public ${releaseChannel} Relay environment must be production`)
  requireConfig(relayEndpoint === 'https://relay.vastbrowser.com', `public ${releaseChannel} Relay endpoint must be production`)
  requireConfig(relayKeyId === 'relay-2026-01', `public ${releaseChannel} Relay trust key must be the production key`)
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exit(1)
}

const metadata = {
  productName: pkg.productName,
  version: pkg.version,
  releaseChannel,
  distributionChannel,
  privateBuild,
  relay: {
    enabled: relayEnabled,
    environment: relayEnvironment,
    endpoint: relayEndpoint,
    keyId: relayKeyId
  },
  updateEnabled,
  obfuscationEnabled,
  releaseRepo,
  sourceCommit,
  signaturePolicy,
  noticesEnabled: notices.enabled,
  noticesFeedOrigin: notices.feedOrigin,
  noticesKeyId: notices.keyId
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

console.log(
  JSON.stringify(
    {
      ok: true,
      outputPath,
      version: metadata.version,
      releaseChannel,
      distributionChannel,
      privateBuild,
      updateEnabled,
      obfuscationEnabled,
      releaseRepo,
      sourceCommit,
      signaturePolicy,
      noticesEnabled: notices.enabled,
      noticesFeedOrigin: notices.feedOrigin,
      noticesKeyId: notices.keyId,
      relay: metadata.relay
    },
    null,
    2
  )
)
