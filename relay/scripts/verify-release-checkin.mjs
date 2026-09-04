import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const relayRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = join(relayRoot, '..')
const version = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version
const sourceCommit = String(process.env.VAST_RELEASE_COMMIT || '').trim().toLowerCase()
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('VAST_RELEASE_COMMIT must identify the exact release source.')

const installId = randomUUID()
const wranglerCli = join(relayRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

function query(sql) {
  const result = spawnSync(process.execPath, [wranglerCli, 'd1', 'execute', 'DB', '--remote', '--env', 'production', '--config', 'public/wrangler.jsonc', '--command', sql, '--json'], {
    cwd: relayRoot,
    encoding: 'utf8',
    env: process.env
  })
  if (result.status !== 0) throw new Error(result.stderr || 'Production D1 verification failed.')
  return JSON.parse(result.stdout)
}

let verificationError
try {
  const response = await fetch('https://relay.vastbrowser.com/v1/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      protocol: 1,
      install_id: installId,
      current_version: version,
      launch_count: 1,
      instance_kind: 'test',
      release_gate_source: sourceCommit
    })
  })
  if (!response.ok) throw new Error(`Production Relay check-in returned HTTP ${response.status}.`)
  const body = await response.json()
  if (body.protocol !== 1) throw new Error('Production Relay returned an incompatible protocol.')
  const result = query(`SELECT install_id,current_version,instance_kind FROM installations WHERE install_id='${installId}'`)
  const row = result?.[0]?.results?.[0]
  if (row?.install_id !== installId || row.current_version !== version || row.instance_kind !== 'test') {
    throw new Error('Production Relay acknowledged check-in without persisting it to the target D1.')
  }
} catch (error) {
  verificationError = error
} finally {
  query(`DELETE FROM installations WHERE install_id='${installId}' AND instance_kind='test'`)
  const remaining = query(`SELECT COUNT(*) AS count FROM installations WHERE install_id='${installId}'`)
  if (remaining?.[0]?.results?.[0]?.count !== 0) throw new Error('Production Relay release-gate fixture cleanup failed.')
}

if (verificationError) throw verificationError
console.log(JSON.stringify({ ok: true, environment: 'production', protocol: 1, version, sourceCommit, fixtureRemoved: true }))
