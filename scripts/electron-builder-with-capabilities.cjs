const { join } = require('node:path')

const pkg = require(join(__dirname, '..', 'package.json'))
module.exports = pkg.build
