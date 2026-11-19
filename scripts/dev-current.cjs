const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

// Starts this checkout (or VAST_DEV_SOURCE_ROOT) on the approved patched
// Electron runtime. dev:stock runs the npm Electron instead.
const sourceRoot = resolve(process.env.VAST_DEV_SOURCE_ROOT || join(__dirname, '..'))

function findPatchedRuntime() {
  if (process.env.VAST_PATCHED_ELECTRON_DIST) return resolve(process.env.VAST_PATCHED_ELECTRON_DIST)
  const manifest = require(join(sourceRoot, 'patches', 'extension-compatibility-runtime.json'))
  const { defaultOutputPath } = require(join(sourceRoot, 'scripts', 'prepare-patched-electron-dist.cjs'))
  const prepared = defaultOutputPath(manifest)
  const executable = process.platform === 'win32' ? 'electron.exe' : 'electron'
  if (!existsSync(join(prepared, executable))) {
    throw new Error(`Cannot find the patched Electron ${manifest.electron.version} runtime at ${prepared}. Run prepare-patched-electron-dist.cjs or set VAST_PATCHED_ELECTRON_DIST.`)
  }
  return prepared
}

try {
  const launcher = join(sourceRoot, 'scripts', 'dev-extension-compat.cjs')
  if (!existsSync(launcher)) throw new Error(`Vast dev launcher is missing: ${launcher}`)
  const patchedDist = findPatchedRuntime()
  console.log(`Starting Vast ${require(join(sourceRoot, 'package.json')).version} from ${sourceRoot}`)
  console.log(`Patched Electron runtime: ${patchedDist}`)
  const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {
    cwd: sourceRoot,
    env: { ...process.env, VAST_PATCHED_ELECTRON_DIST: patchedDist },
    stdio: 'inherit',
    windowsHide: false
  })
  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 0
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
