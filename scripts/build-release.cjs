const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const target = String(process.argv[2] || 'build').trim().toLowerCase()

if (!['build', 'dist', 'upgrader'].includes(target)) {
  console.error(`Unknown build target: ${target}`)
  process.exit(1)
}

const npmCommand = 'npm'
const npxCommand = 'npx'
const powershellCommand = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const useShell = process.platform === 'win32'
const defaultReleaseRepo = process.env.VAST_RELEASE_REPO || 'vstxx/vast-public'
const defaultManifestUrl =
  process.env.VAST_UPDATE_MANIFEST_URL ||
  `https://github.com/${defaultReleaseRepo}/releases/download/v${pkg.version}/update-manifest.json`
const previousVersion = process.env.VAST_PREVIOUS_VERSION || (() => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version)
  if (!match || Number(match[3]) <= 0) return ''
  return `${match[1]}.${match[2]}.${Number(match[3]) - 1}`
})()

const releaseLike = target === 'dist' || target === 'upgrader'
const env = {
  ...process.env,
  VAST_DISTRIBUTION_CHANNEL: 'direct',
  VAST_UPDATE_MANIFEST_URL: defaultManifestUrl,
  VAST_RELEASE_REPO: defaultReleaseRepo
}

if (releaseLike) {
  env.VAST_RELEASE_CHANNEL = process.env.VAST_RELEASE_CHANNEL || 'stable'
  env.VAST_PRIVATE_BUILD = process.env.VAST_PRIVATE_BUILD || '0'
  env.VAST_UPDATE_ENABLED = process.env.VAST_UPDATE_ENABLED || '1'
  env.VAST_OBFUSCATE = process.env.VAST_OBFUSCATE || '1'
}

function run(command, args) {
  const spawnCommand = useShell ? [command, ...args.map(quoteShellArg)].join(' ') : command
  const spawnArgs = useShell ? [] : args
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: useShell
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function quoteShellArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

function buildDist() {
  run(npmCommand, ['run', 'release:check'])
  run(npmCommand, ['run', 'ffmpeg:release:check'])
  run(npmCommand, ['run', 'avidae:runtime:check'])
  run(npmCommand, ['run', 'build:obfuscated'])
  run('node', ['scripts/write-release-build-metadata.cjs'])
  if (process.platform === 'win32') {
    // Build these in separate electron-builder processes. Running both targets in
    // one process can archive win-unpacked while another target is repackaging it.
    // NSIS must run last: unlike portable-only packaging it stages app-update.yml,
    // and that complete tree is the canonical full-update payload.
    for (const windowsTarget of ['portable', 'nsis']) {
      run(npxCommand, electronBuilderArgs(windowsTarget))
    }
  } else {
    run(npxCommand, electronBuilderArgs())
  }
}

function electronBuilderArgs(windowsTarget) {
  const args = ['electron-builder']
  if (windowsTarget) args.push('--win', windowsTarget)
  const allowUnsignedPrivate = env.VAST_PRIVATE_BUILD === '1' && process.env.VAST_ALLOW_UNSIGNED_PRIVATE_BUILD !== '0'
  const allowPublicUnsignedRelease =
    env.VAST_PRIVATE_BUILD === '0' &&
    ['beta', 'stable'].includes(env.VAST_RELEASE_CHANNEL) &&
    env.VAST_PUBLIC_UNSIGNED_RELEASE === '1' &&
    env.VAST_UNSIGNED_RELEASE_ACK === 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
  if (allowPublicUnsignedRelease) {
    args.push('--config', 'scripts/electron-builder-public-unsigned-release.cjs')
  } else if (allowUnsignedPrivate) {
    env.VAST_ALLOW_UNSIGNED_PRIVATE_BUILD = '1'
    args.push('--config', 'scripts/electron-builder-private-unsigned.cjs')
  } else {
    args.push('--config', 'scripts/electron-builder-with-capabilities.cjs')
  }
  return args
}

console.log(`Building Vast target: ${target}`)
console.log(`Standalone updater manifest URL: ${defaultManifestUrl}`)

if (target === 'build') {
  run(npmCommand, ['run', 'build'])
} else if (target === 'dist') {
  buildDist()
} else {
  if (!previousVersion) {
    throw new Error('VAST_PREVIOUS_VERSION is required for a release whose patch version is zero.')
  }
  buildDist()
  run('node', ['scripts/stage-updater-sources.cjs'])
  run(powershellCommand, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/build-updater-bootstrapper.ps1',
    '-Version',
    pkg.version,
    '-DefaultManifestUrl',
    defaultManifestUrl
  ])
  run('node', ['scripts/sign-windows-updater.cjs'])
  run(powershellCommand, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/prepare-release.ps1',
    '-Channel',
    env.VAST_RELEASE_CHANNEL,
    '-Version',
    pkg.version,
    '-PreviousVersion',
    previousVersion,
    '-UpdateBaseUrl',
    `https://github.com/${defaultReleaseRepo}/releases/download/v${pkg.version}/`
  ])
  run(npmCommand, ['run', 'distribution:size-budget'])
  run('node', ['scripts/verify-release-package.cjs'])
}
