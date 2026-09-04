const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const npmCli = process.env.npm_execpath

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!npmCli) throw new Error('npm_execpath is required to run the app test build.')

const isolatedTestEnvironment = {
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
  VAST_RELAY_TEST_OFFLINE: '1',
}

run(process.execPath, [npmCli, 'run', 'build'], isolatedTestEnvironment)
run(process.execPath, ['scripts/smoke-e2e.cjs', ...process.argv.slice(2)], isolatedTestEnvironment)
