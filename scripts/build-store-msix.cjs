const { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const {
  identityFromEnv,
  manifestXml,
  msixVersionForSemver,
  packageVersion,
  root
} = require('./store-msix-config.cjs')
const { windowsSdkTool } = require('./store-msix-tools.cjs')

const development = process.argv.includes('--development')
const identity = identityFromEnv(process.env, development)
const storeRoot = join(root, 'release', 'store')
const stagingRoot = join(storeRoot, 'staging-x64')
const electronRoot = join(root, 'release', 'store-electron', 'win-unpacked')
const artifactPath = join(storeRoot, `Vast-${packageVersion}-Store-x64${development ? '-Development' : ''}.msix`)
const env = {
  ...process.env,
  VAST_DISTRIBUTION_CHANNEL: 'microsoft-store',
  VAST_UPDATE_ENABLED: '0',
  VAST_RELEASE_CHANNEL: development ? 'dev' : (process.env.VAST_RELEASE_CHANNEL || 'stable'),
  VAST_PRIVATE_BUILD: development ? '1' : '0',
  VAST_OBFUSCATE: development ? '0' : '1',
  VAST_RELAY_ENVIRONMENT: development ? (process.env.VAST_RELAY_ENVIRONMENT || 'staging') : 'production',
  VAST_RELAY_ENABLED: process.env.VAST_RELAY_ENABLED || '1',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    windowsHide: true,
    shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const diagnostic = options.capture ? `\n${result.stderr || result.stdout || ''}`.trimEnd() : ''
    throw new Error(`${command} failed with exit code ${result.status}.${diagnostic}`)
  }
  return result.stdout
}

function pruneGeneratedPythonCaches(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') rmSync(path, { recursive: true, force: true })
      else pruneGeneratedPythonCaches(path)
    } else if (entry.isFile() && /\.(?:pyc|pyo)$/i.test(entry.name)) {
      rmSync(path, { force: true })
    }
  }
}

if (process.platform !== 'win32') throw new Error('Vast Store MSIX packaging must run on Windows x64.')
if (process.arch !== 'x64') throw new Error(`Vast Store MSIX packaging requires an x64 build host; received ${process.arch}.`)

if (!development) run(process.execPath, ['scripts/release-store-check.cjs', '--prebuild'])
run(process.execPath, ['scripts/build-app.cjs'])
if (!development) {
  run(process.execPath, ['scripts/obfuscate-build.cjs'])
  run(process.execPath, ['scripts/check-performance-budget.cjs'])
}
run(process.execPath, [
  require.resolve('electron-builder/cli.js'), '--dir', '--win', '--x64', '--config', 'scripts/electron-builder-store.cjs'
])

if (!existsSync(join(electronRoot, 'Vast.exe'))) throw new Error('electron-builder did not produce the expected x64 Vast runtime.')
rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })
cpSync(electronRoot, stagingRoot, { recursive: true, force: true })
pruneGeneratedPythonCaches(stagingRoot)

for (const relativePath of [
  join('resources', 'app-update.yml'),
  'latest.yml',
  'latest-beta.yml'
]) {
  rmSync(join(stagingRoot, relativePath), { force: true })
}

writeFileSync(join(stagingRoot, 'AppxManifest.xml'), manifestXml(identity), 'utf8')
run('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', 'scripts/generate-store-assets.ps1',
  '-Source', 'assets/logos/vasticon-windows.png',
  '-OutputDirectory', join(stagingRoot, 'Assets')
])

mkdirSync(storeRoot, { recursive: true })
rmSync(artifactPath, { force: true })
run(windowsSdkTool('MakeAppx.exe'), ['pack', '/d', stagingRoot, '/p', artifactPath, '/o'], { capture: true })
run(process.execPath, [
  'scripts/verify-store-msix.cjs', artifactPath,
  ...(development ? ['--development'] : [])
])

console.log(JSON.stringify({
  ok: true,
  artifactPath,
  semanticVersion: packageVersion,
  msixVersion: msixVersionForSemver(packageVersion),
  identity,
  signed: false,
  signingModel: development ? 'sign with ephemeral local test certificate before sideloading' : 'Microsoft Store signs after certification'
}, null, 2))
