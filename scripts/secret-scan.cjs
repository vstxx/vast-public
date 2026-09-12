const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const root = join(__dirname, '..')
const local = join(root, '.vast-build/tools/gitleaks', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks')
const binary = process.env.VAST_GITLEAKS_PATH || (existsSync(local) ? local : 'gitleaks')
const snapshot = process.argv[2]
if (!snapshot) {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' })
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') throw new Error('Full history required: run git fetch --unshallow before secret scanning.')
}
const args = snapshot ? ['dir', '.'] : ['git', root, '--log-opts=--all']
const result = spawnSync(binary, [...args, '--config', join(root, '.gitleaks.toml'), '--redact', '--no-banner', '--ignore-gitleaks-allow'], { cwd: snapshot ? resolve(snapshot) : root, stdio: 'inherit', windowsHide: true })
if (result.error) console.error('Gitleaks unavailable: run node scripts/setup-gitleaks.cjs, then retry. ' + result.error.message)
process.exitCode = result.error || result.signal ? 1 : (result.status ?? 1)
