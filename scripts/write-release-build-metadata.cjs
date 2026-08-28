const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { readNoticesReleaseConfig } = require('./notices-release-config.cjs')
const { catAddonEnabled } = require('./build-capabilities.cjs')

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
const privateBuild = flag('VAST_PRIVATE_BUILD', true)
const updateEnabled = flag('VAST_UPDATE_ENABLED', false)
const obfuscationEnabled = flag('VAST_OBFUSCATE', false)
const releaseRepo = String(process.env.VAST_RELEASE_REPO ?? 'vstxx/vast-public').trim() || 'vstxx/vast-public'
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT ?? '').trim().toLowerCase()
const publicDistribution = (releaseChannel === 'beta' || releaseChannel === 'stable') && !privateBuild
const publicUnsignedBeta = publicDistribution && releaseChannel === 'beta' && flag('VAST_PUBLIC_UNSIGNED_BETA', false)
const relayEnvironment = releaseChannel === 'stable' ? 'production' : 'staging'
const relayEnabled = relayEnvironment === 'production'
  ? flag('VAST_RELAY_PRODUCTION_ENABLED', false)
  : flag('VAST_RELAY_ENABLED', true)
const relayEndpoint = relayEnvironment === 'production'
  ? 'https://relay.vastbrowser.com'
  : 'https://relay-staging.vastbrowser.com'
const relayKeyId = relayEnvironment === 'production' ? 'relay-2026-01' : 'relay-staging-2026-01'
const catAddonIncluded = catAddonEnabled(process.env)
const signaturePolicy = publicUnsignedBeta ? 'unsigned-public-beta' : (publicDistribution ? 'authenticode-signed' : 'internal-unsigned')
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

if (publicDistribution) {
  requireConfig(updateEnabled, `public ${releaseChannel} release metadata requires VAST_UPDATE_ENABLED=1`)
  requireConfig(obfuscationEnabled, `public ${releaseChannel} release metadata requires VAST_OBFUSCATE=1`)
  requireConfig(releaseRepo === 'vstxx/vast-public', `public ${releaseChannel} release metadata requires VAST_RELEASE_REPO=vstxx/vast-public`)
  requireConfig(/^[a-f0-9]{40}$/.test(sourceCommit), `public ${releaseChannel} release metadata requires a full VAST_RELEASE_COMMIT SHA`)
  requireConfig(!flag('VAST_PUBLIC_UNSIGNED_BETA', false) || releaseChannel === 'beta', 'VAST_PUBLIC_UNSIGNED_BETA is beta-only')
  if (publicUnsignedBeta) {
    requireConfig(
      String(process.env.VAST_UNSIGNED_BETA_ACK ?? '').trim() === 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK',
      'public unsigned beta metadata requires the explicit risk acknowledgement'
    )
  }
  requireConfig(!catAddonIncluded, `public ${releaseChannel} metadata requires VAST_CAT_ADDON_ENABLED=0`)
  if (releaseChannel === 'beta') {
    requireConfig(relayEnabled, 'public beta metadata requires VAST_RELAY_ENABLED=1')
    requireConfig(relayEnvironment === 'staging', 'public beta Relay environment must be staging')
    requireConfig(relayEndpoint === 'https://relay-staging.vastbrowser.com', 'public beta Relay endpoint must be staging')
    requireConfig(relayKeyId === 'relay-staging-2026-01', 'public beta Relay trust key must be the staging key')
    requireConfig(!flag('VAST_RELAY_PRODUCTION_ENABLED', false), 'public beta metadata requires VAST_RELAY_PRODUCTION_ENABLED=0')
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exit(1)
}

const metadata = {
  productName: pkg.productName,
  version: pkg.version,
  releaseChannel,
  privateBuild,
  catAddonIncluded,
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
