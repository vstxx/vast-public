const { join } = require('node:path')

function enabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').trim().toLowerCase())
}

if (!enabled('VAST_PRIVATE_BUILD') || !enabled('VAST_ALLOW_UNSIGNED_PRIVATE_BUILD')) {
  throw new Error('The private unsigned electron-builder config requires explicit private-build opt-in.')
}

const pkg = require(join(__dirname, '..', 'package.json'))

module.exports = {
  ...pkg.build,
  forceCodeSigning: false,
  win: {
    ...pkg.build.win,
    signExecutable: false
  }
}
