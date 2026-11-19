const semver = require('semver')

// Version used for local private test builds of this machine's Vast. 0.6.0 (not 0.6.0-alpha.N) so the Hub
// treats the build like the real release: it hides password managers and Translator from prereleases.
const DEFAULT_LOCAL_ALPHA_VERSION = '0.6.0'

const LOCAL_ALPHA_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-alpha\.[1-9]\d*)?$/

function assertLocalAlphaVersion(version, sourceVersion) {
  if (!LOCAL_ALPHA_VERSION.test(String(version))) {
    throw new Error('Invalid local alpha version; expected X.Y.Z or X.Y.Z-alpha.N.')
  }
  if (!semver.valid(sourceVersion) || !semver.gt(version, sourceVersion)) {
    throw new Error(`The local alpha version must be newer than the source version ${sourceVersion}.`)
  }
  return version
}

function packagedVersion(sourceVersion, env = process.env) {
  const requested = String(env.VAST_LOCAL_ALPHA_VERSION || '').trim()
  if (!requested) return sourceVersion
  assertLocalAlphaVersion(requested, sourceVersion)
  if (env.VAST_RELEASE_CHANNEL !== 'alpha' || env.VAST_PRIVATE_BUILD !== '1') {
    throw new Error('A local alpha version requires a private alpha build.')
  }
  if (env.VAST_UPDATE_ENABLED !== '0') throw new Error('A local alpha version requires the network updater to be disabled.')
  return requested
}

module.exports = { DEFAULT_LOCAL_ALPHA_VERSION, LOCAL_ALPHA_VERSION, assertLocalAlphaVersion, packagedVersion }
