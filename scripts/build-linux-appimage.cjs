// Builds the Linux x64 AppImage on Linux: the same obfuscated app build and
// release metadata as the Windows release, packaged with the npm Electron.
//   node scripts/build-linux-appimage.cjs                 full build
//   node scripts/build-linux-appimage.cjs --package-only --version 0.0.1 --output <dir>
//     repackages the existing out/ build under another version (update fixtures)
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const packageOnly = args.includes('--package-only')

if (process.platform !== 'linux') {
  console.error('The AppImage is built on Linux.')
  process.exit(1)
}

const env = {
  ...process.env,
  VAST_DISTRIBUTION_CHANNEL: 'direct',
  VAST_RELEASE_REPO: process.env.VAST_RELEASE_REPO || 'vstxx/vast-public',
  VAST_RELEASE_CHANNEL: process.env.VAST_RELEASE_CHANNEL || 'stable',
  VAST_PRIVATE_BUILD: process.env.VAST_PRIVATE_BUILD || '0',
  VAST_UPDATE_ENABLED: process.env.VAST_UPDATE_ENABLED || '1',
  VAST_OBFUSCATE: process.env.VAST_OBFUSCATE || '1'
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!packageOnly) {
  run('npm', ['run', 'license:gpl:check'])
  run('npm', ['run', 'build:obfuscated'])
  run('node', ['scripts/write-release-build-metadata.cjs'])
}

const builderArgs = ['electron-builder', '--linux', '--x64', '--publish', 'never', '--config', 'scripts/electron-builder-linux.cjs']
const version = option('--version')
const output = option('--output')
if (version) builderArgs.push(`-c.extraMetadata.version=${version}`)
if (output) builderArgs.push(`-c.directories.output=${output}`)
run('npx', builderArgs)
