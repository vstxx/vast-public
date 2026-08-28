const { spawnSync } = require('node:child_process')
const { basename, join } = require('node:path')

const root = join(__dirname, '..')
const npmCli = process.env.npm_execpath
const target = basename(String(process.argv[2] ?? ''))
const allowedTargets = new Set(['extensions-e2e.cjs', 'native-extensions-e2e.cjs'])

if (!npmCli) throw new Error('npm_execpath is required to build the Electron E2E runtime.')
if (!allowedTargets.has(target)) throw new Error(`Unsupported isolated Electron E2E target: ${target || '(missing)'}`)

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const isolatedEnvironment = {
  ...process.env,
  VAST_RELAY_ENABLED: '0',
  VAST_RELAY_PRODUCTION_ENABLED: '0',
  VAST_INCLUDE_INTERNAL_TEST_HARNESS: '1',
  VAST_RELAY_TEST_OFFLINE: '1'
}

run(process.execPath, [npmCli, 'run', 'build'], isolatedEnvironment)
run(process.execPath, [join('scripts', target)], isolatedEnvironment)
