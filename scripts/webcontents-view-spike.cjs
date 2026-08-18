const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const electron = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electron, [join(__dirname, 'webcontents-view-spike-runner.cjs')], {
  cwd: root,
  env,
  stdio: 'inherit'
})
process.exitCode = result.status ?? 1
