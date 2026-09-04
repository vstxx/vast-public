const { join } = require('node:path')

function enabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase())
}

if (
  !['beta', 'stable'].includes(process.env.VAST_RELEASE_CHANNEL) ||
  enabled('VAST_PRIVATE_BUILD') ||
  !enabled('VAST_PUBLIC_UNSIGNED_RELEASE') ||
  String(process.env.VAST_UNSIGNED_RELEASE_ACK ?? '').trim() !== 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
) {
  throw new Error('The public unsigned release config requires the exact risk acknowledgement.')
}

const pkg = require(join(__dirname, '..', 'package.json'))

module.exports = {
  ...pkg.build,
  forceCodeSigning: false,
  win: {
    ...pkg.build.win,
    signAndEditExecutable: false,
    signExecutable: false,
    signtoolOptions: undefined
  }
}
