const { execFileSync, spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const branch = 'refs/heads/codex/cws-bridge-integration'

function findCurrentWorktree() {
  const listing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    encoding: 'utf8'
  })
  for (const entry of listing.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/)
    if (!lines.includes(`branch ${branch}`)) continue
    const pathLine = lines.find((line) => line.startsWith('worktree '))
    if (pathLine) return resolve(pathLine.slice('worktree '.length))
  }
  throw new Error(`Cannot find the current Vast worktree (${branch}).`)
}

function findPatchedRuntime(sourceRoot) {
  if (process.env.VAST_PATCHED_ELECTRON_DIST) return resolve(process.env.VAST_PATCHED_ELECTRON_DIST)

  const manifest = require(join(sourceRoot, 'patches', 'extension-compatibility-runtime.json'))
  const { defaultOutputPath } = require(join(sourceRoot, 'scripts', 'prepare-patched-electron-dist.cjs'))
  const candidates = [
    defaultOutputPath(manifest),
    join('C:\\VastCWSBridge', `${manifest.electron.patchsetRevision}-win32-x64`),
    'D:\\VastElectron44\\src\\out\\VastRelease'
  ]
  const found = candidates.find((candidate) => existsSync(join(candidate, 'electron.exe')))
  if (!found) throw new Error(`Cannot find the patched Electron ${manifest.electron.version} runtime. Set VAST_PATCHED_ELECTRON_DIST.`)
  return found
}

let sourceRoot
try {
  sourceRoot = findCurrentWorktree()
  const launcher = join(sourceRoot, 'scripts', 'dev-extension-compat.cjs')
  if (!existsSync(launcher)) throw new Error(`Current Vast dev launcher is missing: ${launcher}`)
  const patchedDist = findPatchedRuntime(sourceRoot)
  const sourceVersion = require(join(sourceRoot, 'package.json')).version
  console.log(`Starting Vast ${sourceVersion} CWS Bridge source from ${sourceRoot}`)
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
