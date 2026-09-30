const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, basename } = require('node:path')

const profile = mkdtempSync(join(tmpdir(), 'vast-css-env-'))
const executable = process.env.VAST_PATCHED_ELECTRON_EXE || 'D:\\VastElectron44\\src\\out\\VastCompat\\electron.exe'
const env = { ...process.env, VAST_CSS_ENV_TEST_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE

try {
  const result = spawnSync(resolve(executable), [join(__dirname, '..', 'tests', 'electron', 'css-env-fallback.cjs')], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60_000
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (basename(profile).startsWith('vast-css-env-')) rmSync(profile, { recursive: true, force: true })
}
