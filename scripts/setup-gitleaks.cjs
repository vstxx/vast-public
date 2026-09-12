// Pinned upstream binaries, checked before extraction. No package-manager install hooks.
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const version = '8.30.1'
async function main() {
  if (process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform)) throw new Error('Install Gitleaks 8.30.1 manually on this platform and put it on PATH.')
  const windows = process.platform === 'win32'
  const name = `gitleaks_${version}_${windows ? 'windows_x64.zip' : 'linux_x64.tar.gz'}`
  const expected = windows ? 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e' : '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
  const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Gitleaks archive SHA256 mismatch')
  const archive = join(mkdtempSync(join(tmpdir(), 'vast-gitleaks-')), name)
  writeFileSync(archive, bytes)
  const output = resolve(process.argv[2] || '.vast-build/tools/gitleaks')
  mkdirSync(output, { recursive: true })
  const result = spawnSync('tar', ['-xf', archive, '-C', output], { stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Cannot extract Gitleaks; install tar or the pinned binary manually.')
  console.log(output)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
