#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const legacyProfile = path.join(root, '.vast-build', 'extension-auth-gate', 'profile')
const isolatedCommand = 'npm run extension:compat:password-gate -- prepare bitwarden'
const validModes = new Set(['bitwarden', 'proton', 'combined'])

function parseLegacyArguments(argv) {
  let mode
  let dryRun = false
  let legacySharedHttp = false
  const values = [...argv]
  while (values.length > 0) {
    const value = values.shift()
    if (value === '--dry-run') dryRun = true
    else if (value === '--legacy-shared-http') legacySharedHttp = true
    else if (value === '--mode') mode = values.shift()
    else if (value.startsWith('--mode=')) mode = value.slice('--mode='.length)
    else throw new Error(`Unknown legacy auth-gate argument: ${value}`)
  }
  if (mode && !validModes.has(mode)) throw new Error(`Unknown isolated password-manager mode: ${mode}`)
  return { mode, dryRun, legacySharedHttp }
}

function migrationNotice() {
  return [
    'The legacy shared HTTP authentication gate is retired.',
    `Its existing profile is preserved for historical evidence and will not be moved or deleted: ${legacyProfile}`,
    'Vast refuses to reuse that shared profile for an isolated compatibility result.',
    `Start with an explicit isolated target: ${isolatedCommand}`
  ].join('\n')
}

function main(argv = process.argv.slice(2)) {
  const args = parseLegacyArguments(argv)
  process.stderr.write(`${migrationNotice()}\n`)
  if (args.legacySharedHttp) {
    process.stderr.write('Read-only historical inspection may be performed manually, but this wrapper cannot launch or pass the legacy HTTP gate.\n')
    process.exitCode = 2
    return
  }
  if (!args.mode) {
    process.exitCode = 2
    return
  }

  const childArgs = [path.join(__dirname, 'password-manager-gate.cjs'), 'prepare', args.mode]
  if (args.dryRun) childArgs.push('--dry-run')
  const result = spawnSync(process.execPath, childArgs, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}

module.exports = { legacyProfile, main, migrationNotice, parseLegacyArguments }
