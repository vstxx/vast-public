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

run(process.execPath, [npmCli, 'run', 'build'], {
  ...process.env,
  VAST_RELAY_ENABLED: '0',
})
run(process.execPath, ['scripts/smoke-e2e.cjs', ...process.argv.slice(2)], process.env)
