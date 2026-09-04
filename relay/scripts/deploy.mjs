import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const relayRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = join(relayRoot, '..')
const environment = process.argv[2]
if (environment !== 'staging' && environment !== 'production') {
  throw new Error('Usage: node scripts/deploy.mjs <staging|production>')
}
if (environment === 'production') {
  const verified = join(relayRoot, 'keys', 'staging-verification.json')
  if (!existsSync(verified) || process.env.VAST_RELAY_ALLOW_PRODUCTION_PROVISION !== 'YES') {
    throw new Error('Production provisioning requires a successful staging verification marker and VAST_RELAY_ALLOW_PRODUCTION_PROVISION=YES.')
  }
  const marker = JSON.parse(readFileSync(verified, 'utf8'))
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' })
  const sourceCommit = String(headResult.stdout || '').trim().toLowerCase()
  const migrationHash = createHash('sha256')
  for (const name of readdirSync(join(relayRoot, 'migrations')).filter((entry) => /^\d+.*\.sql$/.test(entry)).sort()) {
    migrationHash.update(name).update('\0').update(readFileSync(join(relayRoot, 'migrations', name))).update('\0')
  }
  const expected = {
    source_commit: sourceCommit,
    protocol: 1,
    migration_schema_sha256: migrationHash.digest('hex'),
    environment: 'staging',
    database_name: 'vast-relay-staging',
    database_id: '786cd3fa-013f-43fe-bdc4-1ac610e98c87',
    key_id: 'relay-staging-2026-01',
    public_url: 'https://relay-staging.vastbrowser.com',
    control_panel_url: 'https://controlpanel-staging.vastbrowser.com',
    fixtures_removed: true
  }
  const mismatch = Object.entries(expected).find(([key, value]) => marker[key] !== value)
  const verifiedAt = Date.parse(String(marker.verified_at || ''))
  if (headResult.status !== 0 || !/^[a-f0-9]{40}$/.test(sourceCommit) || mismatch || !Number.isFinite(verifiedAt) || Date.now() - verifiedAt > 24 * 60 * 60_000) {
    throw new Error(`Staging verification marker is stale or mismatched${mismatch ? ` (${mismatch[0]})` : ''}; verify this exact source and schema again.`)
  }
}

const wranglerCli = join(relayRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const npmCli = process.env.npm_execpath
const publicConfig = 'public/wrangler.jsonc'
const adminConfig = 'admin/wrangler.jsonc'
const database = environment === 'staging' ? 'vast-relay-staging' : 'vast-relay-production'
const bucket = environment === 'staging' ? 'vast-relay-assets-staging' : 'vast-relay-assets-production'
const keyId = environment === 'staging' ? 'relay-staging-2026-01' : 'relay-2026-01'
const publicKeyPath = join(relayRoot, 'keys', `${keyId}.json`)

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: relayRoot,
    encoding: 'utf8',
    input: options.input,
    env: process.env
  })
  if (!options.quiet) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = result.error instanceof Error ? `: ${result.error.message}` : ''
    throw new Error(`${program} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${detail}.`)
  }
  return result
}

function wrangler(args, options = {}) {
  return command(process.execPath, [wranglerCli, ...args], options)
}

function putSecret(name, value) {
  const result = wrangler(['secret', 'put', name, '--env', environment, '--config', adminConfig], {
    input: `${value}\n`,
    quiet: true
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

function parseJsonOutput(output, description) {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`Wrangler returned invalid JSON while reading ${description}.`)
  }
}

function d1Identifier(info) {
  const identifier = info.uuid || info.id || info.database_id
  if (typeof identifier !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    throw new Error(`Wrangler did not return a valid database ID for ${database}.`)
  }
  return identifier
}

function ensureD1Database() {
  let info = wrangler(['d1', 'info', database, '--json'], { quiet: true, allowFailure: true })
  if (info.status !== 0) {
    wrangler(['d1', 'create', database])
    info = wrangler(['d1', 'info', database, '--json'], { quiet: true })
  }
  const databaseId = d1Identifier(parseJsonOutput(info.stdout, `D1 database ${database}`))
  const configs = [publicConfig, adminConfig].map((configPath) => {
    const absolutePath = join(relayRoot, configPath)
    const config = JSON.parse(readFileSync(absolutePath, 'utf8'))
    const binding = config.env?.[environment]?.d1_databases?.find((entry) => entry.binding === 'DB')
    if (!binding || binding.database_name !== database) {
      throw new Error(`${configPath} does not contain the expected ${environment} D1 binding.`)
    }
    if (binding.database_id && binding.database_id !== databaseId) {
      throw new Error(`${configPath} points ${database} at a different Cloudflare database ID.`)
    }
    binding.database_id = databaseId
    return { absolutePath, contents: `${JSON.stringify(config, null, 2)}\n` }
  })
  for (const config of configs) writeFileSync(config.absolutePath, config.contents, 'utf8')
  return databaseId
}

function ensureR2Bucket() {
  const info = wrangler(['r2', 'bucket', 'info', bucket, '--json'], { quiet: true, allowFailure: true })
  if (info.status !== 0) wrangler(['r2', 'bucket', 'create', bucket])
  wrangler(['r2', 'bucket', 'info', bucket, '--json'], { quiet: true })
}

function keyMaterialFromPrivate(privateKeyBase64) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Configured Relay signing key is not Ed25519.')
  const publicKeyBase64 = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
  return { privateKeyBase64, publicKeyBase64 }
}

function generateKeyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }
}

function writePublicKey(publicKeyBase64) {
  mkdirSync(dirname(publicKeyPath), { recursive: true })
  if (existsSync(publicKeyPath)) {
    const current = JSON.parse(readFileSync(publicKeyPath, 'utf8'))
    if (current.key_id !== keyId || current.public_key_spki_base64 !== publicKeyBase64) {
      throw new Error(`Refusing to replace the committed public key for ${keyId}. Rotate with a new key_id.`)
    }
    return false
  }
  writeFileSync(publicKeyPath, `${JSON.stringify({
    key_id: keyId,
    algorithm: 'Ed25519',
    format: 'DER-SPKI-base64',
    public_key_spki_base64: publicKeyBase64
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  return true
}

function putSigningSecret(material) {
  const createdPublicKeyFile = writePublicKey(material.publicKeyBase64)
  try {
    putSecret('RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64', material.privateKeyBase64)
  } catch (error) {
    if (createdPublicKeyFile && existsSync(publicKeyPath)) unlinkSync(publicKeyPath)
    throw error
  }
}

const adminConfigObject = JSON.parse(readFileSync(join(relayRoot, adminConfig), 'utf8'))
const accessAudience = adminConfigObject.env?.[environment]?.vars?.ACCESS_AUD
if (
  process.env.VAST_RELAY_ACCESS_CONFIRMED !== 'YES' ||
  typeof accessAudience !== 'string' ||
  !/^[a-f0-9]{64}$/i.test(accessAudience)
) {
  throw new Error('Admin deployment requires a configured Access application AUD and VAST_RELAY_ACCESS_CONFIRMED=YES.')
}

wrangler(['whoami'])
const databaseId = ensureD1Database()
ensureR2Bucket()
if (!npmCli) throw new Error('npm_execpath is unavailable; run deployment through npm run deploy:<environment>.')
command(process.execPath, [npmCli, 'run', 'check'])
wrangler(['deploy', '--dry-run', '--env', environment, '--config', publicConfig])
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--env', environment, '--config', publicConfig])
wrangler(['r2', 'bucket', 'dev-url', 'disable', bucket, '--force'])
const domains = wrangler(['r2', 'bucket', 'domain', 'list', bucket], { quiet: true })
if (/https?:\/\//i.test(domains.stdout || '')) throw new Error(`R2 bucket ${bucket} unexpectedly has a public custom domain.`)
wrangler(['deploy', '--env', environment, '--config', publicConfig])

wrangler(['deploy', '--dry-run', '--env', environment, '--config', adminConfig])
wrangler(['deploy', '--env', environment, '--config', adminConfig])
command(process.execPath, [join(repositoryRoot, 'scripts', 'configure-worker-observability.mjs'),
  `vast-relay-public-${environment}`, `vast-relay-admin-${environment}`])

const secretList = wrangler(['secret', 'list', '--env', environment, '--config', adminConfig, '--format', 'json'], { quiet: true })
const existingSecrets = JSON.parse(secretList.stdout || '[]').map((entry) => entry.name)
const providedPrivateKey = process.env.VAST_RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64 || ''
let publicKeyBase64

if (providedPrivateKey) {
  const material = keyMaterialFromPrivate(providedPrivateKey)
  putSigningSecret(material)
  publicKeyBase64 = material.publicKeyBase64
} else if (existingSecrets.includes('RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64')) {
  if (!existsSync(publicKeyPath)) {
    throw new Error(`The signing secret exists but ${publicKeyPath} is missing; the public key cannot be reconstructed from Cloudflare.`)
  }
  publicKeyBase64 = JSON.parse(readFileSync(publicKeyPath, 'utf8')).public_key_spki_base64
} else {
  if (process.env.VAST_RELAY_INITIALIZE_SIGNING_KEY !== 'YES') {
    throw new Error('Initial key creation requires VAST_RELAY_INITIALIZE_SIGNING_KEY=YES or an operator-supplied private key.')
  }
  const material = generateKeyMaterial()
  putSigningSecret(material)
  publicKeyBase64 = material.publicKeyBase64
  material.privateKeyBase64 = randomBytes(64).toString('base64')
}
console.log(JSON.stringify({
  environment,
  public_worker: environment === 'staging' ? 'https://relay-staging.vastbrowser.com' : 'https://relay.vastbrowser.com',
  control_panel: environment === 'staging' ? 'https://controlpanel-staging.vastbrowser.com' : 'https://controlpanel.vastbrowser.com',
  d1: database,
  d1_database_id: databaseId,
  r2: bucket,
  key_id: keyId,
  public_key_spki_base64: publicKeyBase64,
  secrets: ['RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64']
}, null, 2))
