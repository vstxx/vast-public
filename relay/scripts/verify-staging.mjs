import { spawnSync } from 'node:child_process'
import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { lookup as systemLookup } from 'node:dns'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from 'undici'
import { canonicalize } from '../src/shared/canonical.ts'

const relayRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicUrl = 'https://relay-staging.vastbrowser.com'
const adminUrl = 'https://controlpanel-staging.vastbrowser.com'
const adminHostname = new URL(adminUrl).hostname
const adminConnectAddress = process.env.VAST_RELAY_ADMIN_CONNECT_ADDRESS || ''
if (adminConnectAddress && isIP(adminConnectAddress) === 0) {
  throw new Error('VAST_RELAY_ADMIN_CONNECT_ADDRESS must be an IPv4 or IPv6 address.')
}
const adminDispatcher = adminConnectAddress ? new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (hostname !== adminHostname) {
        systemLookup(hostname, options, callback)
        return
      }
      const family = isIP(adminConnectAddress)
      if (typeof options === 'object' && options?.all) {
        callback(null, [{ address: adminConnectAddress, family }])
        return
      }
      callback(null, adminConnectAddress, family)
    }
  }
}) : undefined
const keyId = 'relay-staging-2026-01'
const keyPath = join(relayRoot, 'keys', `${keyId}.json`)
const accessClientId = process.env.VAST_RELAY_ACCESS_CLIENT_ID || ''
const accessClientSecret = process.env.VAST_RELAY_ACCESS_CLIENT_SECRET || ''
if (!accessClientId || !accessClientSecret) {
  throw new Error('Staging verification requires a narrowly scoped Cloudflare Access service token.')
}
if (!existsSync(keyPath)) throw new Error(`Missing staging public key file: ${keyPath}`)
const keyDocument = JSON.parse(readFileSync(keyPath, 'utf8'))
const publicKey = createPublicKey({
  key: Buffer.from(keyDocument.public_key_spki_base64, 'base64'),
  format: 'der',
  type: 'spki'
})

const wranglerCli = join(relayRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
function wranglerJson(args, allowFailure = false) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { cwd: relayRoot, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    if (allowFailure) return null
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`wrangler ${args.join(' ')} failed.`)
  }
  return JSON.parse(result.stdout)
}

function stagingQuery(sql) {
  return wranglerJson(['d1', 'execute', 'DB', '--remote', '--env', 'staging', '--config', 'public/wrangler.jsonc', '--command', sql, '--json'])
}

function productionCount() {
  const databases = wranglerJson(['d1', 'list', '--json'])
  const productionExists = databases.some((database) => database.name === 'vast-relay-production')
  if (!productionExists) return null
  const result = wranglerJson([
    'd1', 'execute', 'vast-relay-production', '--remote', '--command',
    'SELECT COUNT(*) AS count FROM installations', '--json'
  ])
  const count = result?.[0]?.results?.[0]?.count
  if (!Number.isInteger(count) || count < 0) throw new Error('Production installation count query was malformed.')
  return count
}

let accessApplicationToken = ''

function rememberAccessApplicationToken(response) {
  const cookieHeader = response.headers.get('set-cookie') || ''
  const match = cookieHeader.match(/(?:^|,\s*)CF_Authorization=([^;]+)/)
  if (match) accessApplicationToken = match[1]
}

async function accessFetch(path, init = {}) {
  const request = () => fetch(`${adminUrl}${path}`, {
    ...init,
    ...(adminDispatcher ? { dispatcher: adminDispatcher } : {}),
    headers: {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
      ...(accessApplicationToken ? { 'cf-access-token': accessApplicationToken } : {}),
      ...init.headers
    }
  })
  let response = await request()
  const hadApplicationToken = Boolean(accessApplicationToken)
  rememberAccessApplicationToken(response)
  if (!hadApplicationToken && accessApplicationToken && response.status === 401) {
    response = await request()
  }
  return response
}

async function admin(path, init = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await accessFetch(path, {
      ...init,
      headers: {
        ...(init.method && init.method !== 'GET' ? { Origin: adminUrl } : {}),
        ...init.headers
      }
    })
    const body = await response.json().catch(() => null)
    if (response.ok) return body
    if (response.status !== 401 || attempt === 19) {
      throw new Error(`Admin ${init.method || 'GET'} ${path} failed with ${response.status}: ${JSON.stringify(body)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error('Admin request exhausted its authentication propagation retries.')
}

async function waitForAdminDeployment() {
  let lastStatus = 0
  let consecutiveSuccesses = 0
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await accessFetch('/health')
      lastStatus = response.status
      if (response.ok) {
        consecutiveSuccesses += 1
        if (consecutiveSuccesses === 3) return
      } else {
        consecutiveSuccesses = 0
      }
    } catch {
      lastStatus = 0
      consecutiveSuccesses = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error(`Access-protected Control Panel did not become healthy; last HTTP status was ${lastStatus || 'unavailable'}.`)
}

function verifyEnvelope(envelope) {
  if (envelope.key_id !== keyId || envelope.payload.key_id !== keyId) return false
  return verify(
    null,
    Buffer.from(canonicalize(envelope.payload), 'utf8'),
    publicKey,
    Buffer.from(envelope.signature, 'base64')
  )
}

const productionBefore = productionCount()
const installId = randomUUID()
let assetId = ''
let disabledId = ''
let enabledId = ''
let disabledRevision = ''
let enabledRevision = ''
let verificationError

try {
await waitForAdminDeployment()
const firstResponse = await fetch(`${publicUrl}/v1/checkin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ protocol: 1, install_id: installId, current_version: '0.1.4', launch_count: 1, instance_kind: 'test' })
})
if (!firstResponse.ok) throw new Error(`First staging check-in failed with HTTP ${firstResponse.status}.`)
const first = await firstResponse.json()
if (first.protocol !== 1 || typeof first.server_time !== 'string') throw new Error('Staging check-in response is malformed.')
await new Promise((resolve) => setTimeout(resolve, 50))
const repeatResponse = await fetch(`${publicUrl}/v1/checkin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ protocol: 1, install_id: installId, current_version: '0.1.4', launch_count: 2, instance_kind: 'test' })
})
if (!repeatResponse.ok) throw new Error(`Repeat staging check-in failed with HTTP ${repeatResponse.status}.`)

const installation = stagingQuery(`SELECT install_id, first_seen, last_seen, launch_count, instance_kind FROM installations WHERE install_id = '${installId}'`)
const row = installation?.[0]?.results?.[0]
if (!row || row.install_id !== installId || row.first_seen >= row.last_seen || row.launch_count !== 2 || row.instance_kind !== 'test') {
  throw new Error('Staging D1 did not preserve the expected installation record.')
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const asset = await admin('/v1/admin/assets', {
  method: 'PUT',
  headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) },
  body: png
})
assetId = String(asset.id || '')
if (!assetId) throw new Error('Staging asset upload did not return an ID.')

const now = Date.now()
disabledId = randomUUID()
const disabled = await admin('/v1/admin/broadcasts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: disabledId,
    type: 'announcement',
    title: 'Disabled staging broadcast',
    body: 'This remains disabled as a control-plane test record.',
    media_id: null,
    action_label: null,
    action_url: null,
    min_version: null,
    max_version: null,
    active_from: new Date(now - 60_000).toISOString(),
    active_until: new Date(now + 300_000).toISOString(),
    priority: 1,
    enabled: false
  })
})
disabledRevision = String(disabled.revision || '')
if (!disabledRevision) throw new Error('Disabled staging broadcast did not return a revision.')

enabledId = randomUUID()
const enabled = await admin('/v1/admin/broadcasts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: enabledId,
    type: 'seasonal',
    title: 'Vast Relay staging hello',
    body: 'Short-lived staging verification message.',
    media_id: assetId,
    action_label: null,
    action_url: null,
    min_version: '0.1.0',
    max_version: '1.0.0',
    active_from: new Date(now - 60_000).toISOString(),
    active_until: new Date(now + 300_000).toISOString(),
    priority: 100,
    enabled: true
  })
})
enabledRevision = String(enabled.revision || '')
if (!enabledRevision) throw new Error('Enabled staging broadcast did not return a revision.')
if (!verifyEnvelope(enabled)) throw new Error('Admin-created staging broadcast signature did not verify.')

const deliveredResponse = await fetch(`${publicUrl}/v1/checkin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ protocol: 1, install_id: installId, current_version: '0.1.4', launch_count: 3, instance_kind: 'test' })
})
const delivered = await deliveredResponse.json()
const message = delivered.messages.find((candidate) => candidate.payload?.id === enabledId)
if (!message || !verifyEnvelope(message)) throw new Error('Public staging delivery omitted or invalidated the signed test broadcast.')
if (delivered.messages.some((candidate) => candidate.payload?.id === disabledId)) throw new Error('Disabled staging broadcast was delivered.')

const fetchedAsset = await fetch(`${publicUrl}/v1/assets/${assetId}`)
if (!fetchedAsset.ok || fetchedAsset.headers.get('content-type') !== 'image/png') throw new Error('Controlled staging asset retrieval failed.')
const fetchedDigest = Buffer.from(await crypto.subtle.digest('SHA-256', await fetchedAsset.arrayBuffer())).toString('hex')
if (fetchedDigest !== asset.sha256) throw new Error('Controlled staging asset digest did not match signed metadata.')
} catch (error) {
  verificationError = error
}

const cleanupErrors = []
async function cleanup(label, operation) {
  try { await operation() } catch (error) { cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)) }
}
if (enabledId && enabledRevision) await cleanup('enabled broadcast cleanup failed', () => admin(`/v1/admin/broadcasts/${encodeURIComponent(enabledId)}`, {
  method: 'DELETE', headers: { 'If-Match': `"${enabledRevision}"` }
}))
if (disabledId && disabledRevision) await cleanup('disabled broadcast cleanup failed', () => admin(`/v1/admin/broadcasts/${encodeURIComponent(disabledId)}`, {
  method: 'DELETE', headers: { 'If-Match': `"${disabledRevision}"` }
}))
if (assetId) await cleanup('asset cleanup failed', () => admin(`/v1/admin/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }))
await cleanup('test installation cleanup failed', () => {
  stagingQuery(`DELETE FROM installations WHERE install_id = '${installId}' AND instance_kind = 'test'`)
  const remaining = stagingQuery(`SELECT COUNT(*) count FROM installations WHERE install_id = '${installId}' AND instance_kind = 'test'`)
  if (remaining?.[0]?.results?.[0]?.count !== 0) throw new Error('the explicitly tagged test installation remains in staging')
})

const productionAfter = productionCount()
if (productionBefore !== productionAfter) cleanupErrors.push(new Error('Production installation count changed during staging verification.'))
if (verificationError || cleanupErrors.length > 0) throw new AggregateError([...(verificationError ? [verificationError] : []), ...cleanupErrors], 'Relay staging verification or fixture cleanup failed.')

const verificationPath = join(relayRoot, 'keys', 'staging-verification.json')
mkdirSync(dirname(verificationPath), { recursive: true })
writeFileSync(verificationPath, `${JSON.stringify({
  verified_at: new Date().toISOString(),
  public_url: publicUrl,
  control_panel_url: adminUrl,
  install_id: installId,
  disabled_broadcast_id: disabledId,
  enabled_broadcast_id: enabledId,
  asset_id: assetId,
  fixtures_removed: true,
  key_id: keyId,
  public_key_spki_base64: keyDocument.public_key_spki_base64,
  production_installation_count_before: productionBefore,
  production_installation_count_after: productionAfter
}, null, 2)}\n`)

console.log(readFileSync(verificationPath, 'utf8'))
