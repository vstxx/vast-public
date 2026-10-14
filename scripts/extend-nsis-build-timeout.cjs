const fs = require('node:fs')

const version = require('builder-util/package.json').version
if (version !== '26.15.3') throw new Error(`Unexpected builder-util version: ${version}`)

const file = require.resolve('builder-util/out/util.js')
const source = fs.readFileSync(file, 'utf8')
const start = source.indexOf('function spawnAndWriteWithOutput(')
const end = source.indexOf('\nfunction ', start + 1)
if (start < 0 || end < 0) throw new Error('NSIS build timeout function was not found')

const before = source.slice(start, end)
const fourMinutes = '}, 4 * 60 * 1000);'
const thirtyMinutes = '}, 30 * 60 * 1000);'
const originalError = 'timed out after 4 minutes'
const extendedError = 'timed out after 30 minutes'
if (before.includes(thirtyMinutes) && before.includes(extendedError)) {
  console.log('NSIS build timeout is already 30 minutes.')
  process.exit(0)
}
if (before.split(fourMinutes).length !== 2 || before.split(originalError).length !== 2) {
  throw new Error('builder-util NSIS timeout no longer matches the pinned version')
}

const after = before.replace(fourMinutes, thirtyMinutes).replace(originalError, extendedError)
fs.writeFileSync(file, source.slice(0, start) + after + source.slice(end))
console.log('Extended pinned builder-util NSIS process timeout from 4 to 30 minutes.')
