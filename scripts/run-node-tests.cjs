const { readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = join(__dirname, '..')
const testsRoot = join(root, 'tests')

function runPreparation(script, args = [], capture = false) {
  return spawnSync(process.execPath, [join(__dirname, script), ...args], {
    cwd: root,
    env: process.env,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    windowsHide: true
  })
}

let ece = runPreparation('prepare-extension-compat-runtime.cjs', ['--check'], true)
if (ece.status !== 0) {
  ece = runPreparation('prepare-extension-compat-runtime.cjs')
  if (ece.error || ece.status !== 0) process.exit(ece.status ?? 1)
}
ece = runPreparation('prepare-extension-compat-runtime.cjs', ['--check'])
if (ece.error || ece.status !== 0) process.exit(ece.status ?? 1)

const adblock = runPreparation('build-adblock-extension.mjs')
if (adblock.error || adblock.status !== 0) process.exit(adblock.status ?? 1)

function collect(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) files.push(...collect(full))
    else if (entry.endsWith('.test.ts')) files.push(full)
  }
  return files
}

const files = collect(testsRoot).filter((file) => !file.includes(`${join('tests', 'updater')}`))
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    VAST_RELEASE_CHANNEL: process.env.VAST_RELEASE_CHANNEL || 'dev',
  }
})

process.exit(result.status ?? 1)
