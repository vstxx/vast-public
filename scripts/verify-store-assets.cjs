const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const root = join(__dirname, '..')

function verifyStoreAssets(directory) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(__dirname, 'generate-store-assets.ps1'),
    '-Source', join(root, 'assets/logos/vasticon-windows.png'),
    '-OutputDirectory', directory, '-VerifyOnly'
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`Store icon validation failed: ${result.stderr || result.stdout || result.error?.message}`)
  }
}

module.exports = { verifyStoreAssets }
