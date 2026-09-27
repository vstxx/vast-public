const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync, spawn } = require('node:child_process')

const root = join(__dirname, '..')
const defaultDist = 'D:\\VastElectron44\\src\\out\\VastCompat'
const patchedDist = resolve(process.env.VAST_PATCHED_ELECTRON_DIST || defaultDist)
const executable = join(patchedDist, process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!existsSync(executable)) {
  console.error(`Patched Electron executable was not found: ${executable}`)
  process.exit(1)
}

let prepared = spawnSync(process.execPath, [join(__dirname, 'prepare-extension-compat-runtime.cjs'), '--check'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe'
})
if (prepared.status !== 0) {
  prepared = spawnSync(process.execPath, [join(__dirname, 'prepare-extension-compat-runtime.cjs')], {
    cwd: root,
    stdio: 'inherit'
  })
} else if (prepared.stdout) {
  process.stdout.write(prepared.stdout)
}
if (prepared.status !== 0) process.exit(prepared.status ?? 1)

const verified = spawnSync(process.execPath, [join(__dirname, 'verify-extension-compat-runtime.cjs')], {
  cwd: root,
  env: { ...process.env, VAST_PATCHED_ELECTRON_DIST: patchedDist },
  stdio: 'inherit'
})
if (verified.status !== 0) process.exit(verified.status ?? 1)

const env = {
  ...process.env,
  ELECTRON_EXEC_PATH: executable,
  VAST_PATCHED_ELECTRON_DIST: patchedDist,
  VAST_PATCHED_ELECTRON_COMPAT: '1',
  VAST_EXTENSION_COMPATIBILITY: '1'
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [join(__dirname, 'dev.cjs'), ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
