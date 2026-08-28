const { join } = require('node:path')
const { withBuildCapabilities } = require('./build-capabilities.cjs')

function enabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase())
}

if (
  process.env.VAST_RELEASE_CHANNEL !== 'beta' ||
  enabled('VAST_PRIVATE_BUILD') ||
  !enabled('VAST_PUBLIC_UNSIGNED_BETA') ||
  String(process.env.VAST_UNSIGNED_BETA_ACK ?? '').trim() !== 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK'
) {
  throw new Error('The public unsigned beta config requires the exact beta-only risk acknowledgement.')
}

const pkg = require(join(__dirname, '..', 'package.json'))

module.exports = {
  ...withBuildCapabilities(pkg.build),
  forceCodeSigning: false,
  win: {
    ...pkg.build.win,
    signAndEditExecutable: false,
    signExecutable: false,
    signtoolOptions: undefined
  }
}
