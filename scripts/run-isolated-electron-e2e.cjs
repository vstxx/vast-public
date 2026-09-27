const { spawnSync } = require('node:child_process')
const { basename, join, resolve } = require('node:path')

const root = join(__dirname, '..')
const npmCli = process.env.npm_execpath
const target = basename(String(process.argv[2] ?? ''))
const allowedTargets = new Set(['extensions-e2e.cjs', 'native-extensions-e2e.cjs', 'native-messaging-e2e.cjs', 'adblock-extension-e2e.cjs'])
const compatibilityTargets = new Set(['extensions-e2e.cjs', 'adblock-extension-e2e.cjs'])

if (!npmCli) throw new Error('npm_execpath is required to build the Electron E2E runtime.')
if (!allowedTargets.has(target)) throw new Error(`Unsupported isolated Electron E2E target: ${target || '(missing)'}`)

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const isolatedEnvironment = {
  ...process.env,
  VAST_RELEASE_CHANNEL: 'dev',
  VAST_DISTRIBUTION_CHANNEL: 'direct',
  VAST_PRIVATE_BUILD: '1',
  VAST_PUBLIC_UNSIGNED_RELEASE: '0',
  VAST_UNSIGNED_RELEASE_ACK: '',
  VAST_UPDATE_ENABLED: '0',
  VAST_OBFUSCATE: '0',
  VAST_RELEASE_COMMIT: '',
  VAST_RELAY_ENABLED: '0',
  VAST_RELAY_ENVIRONMENT: 'staging',
  VAST_INCLUDE_INTERNAL_TEST_HARNESS: '1',
  VAST_RELAY_TEST_OFFLINE: '1'
}

if (compatibilityTargets.has(target)) {
  isolatedEnvironment.VAST_EXTENSION_COMPATIBILITY = '1'
  isolatedEnvironment.VAST_PATCHED_ELECTRON_COMPAT = '1'
  isolatedEnvironment.VAST_PATCHED_ELECTRON_DIST = resolve(
    process.env.VAST_PATCHED_ELECTRON_DIST || 'D:\\VastElectron44\\src\\out\\VastCompat'
  )
  run(process.execPath, [join('scripts', 'verify-extension-compat-runtime.cjs')], isolatedEnvironment)
}

run(process.execPath, [npmCli, 'run', 'build'], isolatedEnvironment)
run(process.execPath, [join('scripts', target)], isolatedEnvironment)
