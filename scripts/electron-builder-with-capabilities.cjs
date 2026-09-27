const { join } = require('node:path')
const { approvedElectronDist } = require('./verify-extension-compat-runtime.cjs')

const pkg = require(join(__dirname, '..', 'package.json'))
const compatibilityManifest = require(join(__dirname, '..', 'patches', 'extension-compatibility-runtime.json'))
module.exports = {
  ...pkg.build,
  electronDist: approvedElectronDist({ manifest: compatibilityManifest })
}
