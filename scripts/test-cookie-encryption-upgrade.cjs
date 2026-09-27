const { spawnSync } = require('node:child_process')
const { cpSync, existsSync, mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const root = join(__dirname, '..')
const sourceElectron = require('electron')
const sourceDist = resolve(sourceElectron, '..')
const fixture = join(__dirname, 'cookie-encryption-fixture.cjs')

function run(executable, mode, userData) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(executable, [fixture, mode, userData], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(`Cookie encryption ${mode} failed: ${result.error?.message || result.stderr || result.stdout}`)
}

async function main() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'vast-cookie-encryption-'))
  const hardenedDist = join(temporaryRoot, 'electron-dist')
  const userData = join(temporaryRoot, 'profile')
  try {
    run(sourceElectron, 'seed', userData)
    cpSync(sourceDist, hardenedDist, { recursive: true })
    const executable = process.platform === 'darwin'
      ? join(hardenedDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(hardenedDist, process.platform === 'win32' ? 'electron.exe' : 'electron')
    if (!existsSync(executable)) throw new Error(`Copied Electron executable was not found: ${executable}`)
    const fuses = await import('@electron/fuses')
    await fuses.flipFuses(executable, {
      version: fuses.FuseVersion.V1,
      strictlyRequireAllFuses: false,
      [fuses.FuseV1Options.EnableCookieEncryption]: true
    })
    run(executable, 'verify', userData)
    run(executable, 'verify', userData)
    console.log('Cookie encryption upgrade test passed: default, shared-workspace, and isolated persistent cookies survived enablement and restart.')
  } finally {
    // Windows antivirus/indexing can briefly hold handles after Electron exits.
    // Keep cleanup mandatory, but retry transient sharing violations.
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
