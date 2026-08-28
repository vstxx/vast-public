const { join } = require('node:path')
const { withBuildCapabilities } = require('./build-capabilities.cjs')

const pkg = require(join(__dirname, '..', 'package.json'))
module.exports = withBuildCapabilities(pkg.build)
