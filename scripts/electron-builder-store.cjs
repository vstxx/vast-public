const { join } = require('node:path')

const pkg = require(join(__dirname, '..', 'package.json'))
if (process.env.VAST_DISTRIBUTION_CHANNEL !== 'microsoft-store') {
  throw new Error('The Store electron-builder config requires VAST_DISTRIBUTION_CHANNEL=microsoft-store.')
}
if (String(process.env.VAST_UPDATE_ENABLED ?? '') !== '0') {
  throw new Error('Microsoft Store builds require VAST_UPDATE_ENABLED=0.')
}

module.exports = {
  ...pkg.build,
  // Partner Center signs the accepted MSIX. Requiring a separate publisher
  // Authenticode certificate here would make Store submission depend on a
  // certificate that the Store route neither needs nor uses.
  forceCodeSigning: false,
  afterSign: undefined,
  publish: null,
  directories: {
    ...pkg.build.directories,
    output: 'release/store-electron'
  },
  win: {
    ...pkg.build.win,
    target: ['dir'],
    signAndEditExecutable: false,
    signExecutable: false,
    signtoolOptions: undefined
  }
}
