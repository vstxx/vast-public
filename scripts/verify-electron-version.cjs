const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const expected = Object.freeze({ electron: '44.3.0', chrome: '152.0.7977.78', node: '24.20.0', v8: '15.2.124.19-electron.0' })
const packageVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const executable = require('electron')
const output = execFileSync(executable, ['-p', 'JSON.stringify(process.versions)'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000
}).trim()
const actual = JSON.parse(output)
const failures = []
if (packageVersion !== expected.electron) failures.push(`electron package is ${packageVersion}`)
for (const [component, version] of Object.entries(expected)) if (actual[component] !== version) failures.push(`${component} is ${actual[component]}; expected ${version}`)
console.log(JSON.stringify({ ok: failures.length === 0, expected, actual: Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])), failures }, null, 2))
if (failures.length) process.exit(1)
