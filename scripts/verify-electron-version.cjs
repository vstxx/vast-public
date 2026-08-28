const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const expected = Object.freeze({ electron: '43.4.1', chrome: '150.0.7871.224', node: '24.18.1', v8: '15.0.245.28-electron.0' })
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
