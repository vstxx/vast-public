#!/usr/bin/env node
// Local, manually invoked update of this machine's existing Vast installation.
// This never creates a feed, signs a release, or publishes an artifact.
const { execFileSync, spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const asar = require('@electron/asar')
const {
  resolveDailyProfile, assertAlphaMetadata, assertOutside,
  createPayloadManifest, verifyPayloadManifest
} = require('./local-alpha-update-utils.cjs')

const root = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifestPath = join(root, '.vast-build', 'local-alpha', 'manifest.json')
const payloadPath = join(root, 'release', 'win-unpacked')
const sourceDir = resolve(process.env.VAST_PATCHED_ELECTRON_SOURCE_DIR || 'D:\\VastElectron44\\src\\out\\VastRelease')
const mode = process.argv[2] || 'status'
const requestedVersion = process.env.VAST_LOCAL_ALPHA_VERSION || '0.5.0-alpha.1'
const version = mode === 'prepare' || !existsSync(manifestPath)
  ? requestedVersion
  : JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')).version

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

function sourceCommit() {
  const commit = git('rev-parse', 'HEAD').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('The current source commit is invalid.')
  if (git('status', '--porcelain', '--untracked-files=all')) {
    throw new Error('Commit the current CWS Bridge changes before preparing or applying a local alpha update.')
  }
  return commit
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root, env, stdio: 'inherit', windowsHide: false,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`)
}

function packagedMetadata() {
  const appAsar = join(payloadPath, 'resources', 'app.asar')
  if (!existsSync(appAsar)) throw new Error('The local alpha payload has no app.asar.')
  return JSON.parse(asar.extractFile(appAsar, 'out/release-build-metadata.json').toString('utf8'))
}

async function prepare() {
  if (process.platform !== 'win32') throw new Error('The local alpha updater is Windows only.')
  const commit = sourceCommit()
  assertAlphaMetadata({ version, releaseChannel: 'alpha', distributionChannel: 'direct', privateBuild: true, updateEnabled: false, sourceCommit: commit }, version, commit)
  if (!existsSync(join(sourceDir, 'electron.exe'))) throw new Error(`The patched Electron release runtime is missing: ${sourceDir}`)
  const env = {
    ...process.env,
    VAST_PATCHED_ELECTRON_SOURCE_DIR: sourceDir,
    VAST_RELEASE_COMMIT: commit,
    VAST_LOCAL_ALPHA_VERSION: version,
    VAST_RELEASE_CHANNEL: 'alpha',
    VAST_DISTRIBUTION_CHANNEL: 'direct',
    VAST_PRIVATE_BUILD: '1',
    VAST_UPDATE_ENABLED: '0',
    VAST_OBFUSCATE: '0',
    VAST_RELAY_ENABLED: '1',
    VAST_RELAY_ENVIRONMENT: 'production',
    VAST_EXTENSION_COMPATIBILITY_FINGERPRINT_REQUIRED: '1',
    VAST_ALLOW_UNSIGNED_PRIVATE_BUILD: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  }
  for (const key of ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']) delete env[key]

  run(process.execPath, ['scripts/prepare-extension-compat-runtime.cjs', '--check'], env)
  run(process.execPath, ['scripts/release-check.cjs'], env)
  run(process.execPath, ['scripts/prepare-patched-electron-dist.cjs'], env)
  env.VAST_PATCHED_ELECTRON_DIST = require('./prepare-patched-electron-dist.cjs').defaultOutputPath(require('../patches/extension-compatibility-runtime.json'))
  run(process.execPath, ['scripts/verify-extension-compat-runtime.cjs', '--release', '--write', 'out/extension-compatibility-runtime-fingerprint.json'], env)
  run(process.execPath, ['scripts/check-radius.cjs'], env)
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], env)
  run(process.execPath, ['scripts/build-app.cjs'], env)
  run(process.execPath, [join(root, 'node_modules', 'electron-builder', 'cli.js'), '--dir', '--win', '--x64', '--publish', 'never', '--config', 'scripts/electron-builder-private-unsigned.cjs'], env)
  run(process.execPath, ['scripts/verify-private-runtime-package.cjs'], env)

  const metadata = packagedMetadata()
  assertAlphaMetadata(metadata, version, commit)
  writeFileSync(join(payloadPath, 'version.json'), `${JSON.stringify({ product: 'Vast Browser', version, channel: 'alpha', sourceCommit: commit }, null, 2)}\n`)
  const payload = await createPayloadManifest(payloadPath)
  const manifest = { schemaVersion: 1, version, sourceCommit: commit, payload }
  mkdirSync(join(root, '.vast-build', 'local-alpha'), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Local alpha ${version} prepared from ${commit}.`)
  console.log(`Payload: ${payloadPath}`)
  console.log('Close Vast, then run: npm run alpha:apply')
}

async function verifiedManifest() {
  const commit = sourceCommit()
  if (!existsSync(manifestPath)) throw new Error('No prepared local alpha payload. Run npm run alpha:prepare first.')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.sourceCommit !== commit) {
    throw new Error('The prepared alpha payload does not match the current source version and commit.')
  }
  await verifyPayloadManifest(payloadPath, manifest.payload)
  assertAlphaMetadata(packagedMetadata(), version, commit)
  return manifest
}

async function apply(dryRun = false) {
  if (process.platform !== 'win32') throw new Error('The local alpha updater is Windows only.')
  await verifiedManifest()
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  if (!localAppData || !appData) throw new Error('Windows LOCALAPPDATA and APPDATA are required.')
  const install = join(localAppData, 'Programs', 'Vast')
  if (!existsSync(join(install, 'Vast.exe')) || !existsSync(join(install, 'Uninstall Vast.exe'))) {
    throw new Error(`The existing daily Vast installation was not found: ${install}`)
  }
  const profile = resolveDailyProfile(appData)
  assertOutside(profile, install, 'The daily profile')
  assertOutside(payloadPath, install, 'The alpha payload')
  const backupRoot = join(localAppData, 'Vast', 'AlphaUpdateBackups')
  console.log(`Updating: ${realpathSync(install)}`)
  console.log(`Daily profile: ${profile}`)
  console.log(`Backup parent: ${backupRoot}`)
  if (!dryRun) {
    mkdirSync(backupRoot, { recursive: true })
    const config = join(appData, 'Vast', 'data-root.json')
    if (existsSync(config)) {
      copyFileSync(config, join(backupRoot, `data-root-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
    }
  }
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'resources', 'updater', 'VastUpdater.ps1'),
    '-InstallPath', install, '-PayloadPath', payloadPath, '-UserDataRoot', profile,
    '-BackupRoot', backupRoot, '-TargetVersion', version, '-TargetChannel', 'alpha', '-NonInteractive'
  ]
  if (dryRun) args.push('-DryRun')
  run('powershell.exe', args)
}

async function main() {
  if (mode === 'prepare') return prepare()
  if (mode === 'apply') return apply(false)
  if (mode === 'check') return apply(true)
  if (mode === 'status') {
    const manifest = await verifiedManifest()
    console.log(JSON.stringify({ ok: true, version: manifest.version, sourceCommit: manifest.sourceCommit, payloadPath }, null, 2))
    return
  }
  throw new Error('Use local-alpha-update.cjs prepare|check|apply|status.')
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
