const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('npx', ['tsc', '--noEmit'])
run('npx', ['electron-vite', 'build'])
run('node', ['scripts/write-release-build-metadata.cjs'])
