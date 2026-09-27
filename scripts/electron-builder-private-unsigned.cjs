const { join } = require('node:path')
const { approvedElectronDist } = require('./verify-extension-compat-runtime.cjs')

function enabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase())
}

if (!enabled('VAST_PRIVATE_BUILD') || !enabled('VAST_ALLOW_UNSIGNED_PRIVATE_BUILD')) {
  throw new Error('The private unsigned electron-builder config requires explicit private-build opt-in.')
}

const pkg = require(join(__dirname, '..', 'package.json'))
const compatibilityManifest = require(join(__dirname, '..', 'patches', 'extension-compatibility-runtime.json'))

module.exports = {
  ...pkg.build,
  electronDist: approvedElectronDist({ manifest: compatibilityManifest }),
  forceCodeSigning: false,
  win: {
    ...pkg.build.win,
    signExecutable: false
  }
}
