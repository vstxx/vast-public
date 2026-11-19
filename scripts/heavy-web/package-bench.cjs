#!/usr/bin/env node
// Packages the current tree like the Store route (patched runtime, fuses,
// electron-builder --dir, Store development metadata) into .vast-build/heavy-web/<label>,
// so A/B variants run as real packaged builds without touching release/.
// Usage: node scripts/heavy-web/package-bench.cjs --label=<name> [--obfuscate=1]
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')))
if (!args.label || !/^[a-z0-9-]+$/.test(args.label)) throw new Error('Usage: --label=<lowercase-name>')
const output = path.join(root, '.vast-build', 'heavy-web', args.label)
const compatibilityManifest = require('../../patches/extension-compatibility-runtime.json')
const { defaultOutputPath } = require('../prepare-patched-electron-dist.cjs')

const env = {
  ...process.env,
  VAST_DISTRIBUTION_CHANNEL: 'microsoft-store',
  VAST_UPDATE_ENABLED: '0',
  // The Store development profile: same runtime and packaging, without the
  // public-release metadata gates (commit pinning, Relay, obfuscation).
  VAST_RELEASE_CHANNEL: 'dev',
  VAST_PRIVATE_BUILD: '1',
  VAST_OBFUSCATE: args.obfuscate === '1' ? '1' : '0',
  VAST_RELAY_ENABLED: '0',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  VAST_PATCHED_ELECTRON_DIST: defaultOutputPath(compatibilityManifest)
}
delete env.ELECTRON_RUN_AS_NODE

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed with ${result.status}`)
}

run(process.execPath, ['scripts/build-app.cjs'])
if (args.obfuscate === '1') run(process.execPath, ['scripts/obfuscate-build.cjs'])
const config = path.join(root, '.vast-build', 'heavy-web', `builder-${args.label}.cjs`)
fs.mkdirSync(path.dirname(config), { recursive: true })
fs.writeFileSync(config, `const base = require(${JSON.stringify(path.join(root, 'scripts', 'electron-builder-store.cjs'))})
module.exports = { ...base, directories: { ...base.directories, output: ${JSON.stringify(output)} } }
`)
fs.rmSync(output, { recursive: true, force: true })
run(process.execPath, [require.resolve('electron-builder/cli.js'), '--dir', '--win', '--x64', '--config', config])
const exe = path.join(output, 'win-unpacked', 'Vast.exe')
if (!fs.existsSync(exe)) throw new Error('Packaging did not produce Vast.exe')
console.log(exe)
