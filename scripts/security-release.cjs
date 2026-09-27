const { spawnSync } = require('node:child_process')

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this gate through npm run security:release.')
const commands = [
  ['dependency audit', ['run', 'audit:ci']], ['typecheck and static policy', ['run', 'lint']],
  ['security regression suite', ['test']], ['release security contracts', ['run', 'test:release']],
  ['Relay checks', ['run', 'check', '--prefix', 'relay']], ['Hub typecheck', ['run', 'hub:typecheck']],
  ['Hub tests', ['run', 'hub:test']], ['Hub signer dry build', ['run', 'build:signer', '--prefix', 'extensions-hub']],
  ['Hub production trust read', ['run', 'hub:verify:production']],
  ['Electron runtime versions', ['run', 'test:electron-version']], ['Electron fuses integration', ['run', 'test:fuses:integration']],
  ['cookie encryption upgrade', ['run', 'test:cookie-encryption']], ['updater source staging', ['run', 'updater:stage']],
  ['updater security and rollback', ['run', 'test:updater']], ['updater download and background install security', ['run', 'test:updater:background']],
  ['release architecture audit', ['run', 'release:audit']]
]
for (const [label, args] of commands) {
  console.log(`\n[security:release] ${label}`)
  const result = spawnSync(process.execPath, [npm, ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) { console.error(`[security:release] FAIL: ${label}`); process.exit(result.status || 1) }
}
console.log('\n[security:release] PASS')
