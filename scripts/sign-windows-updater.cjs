const { spawnSync } = require('node:child_process')
const {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, isAbsolute, join, resolve } = require('node:path')
const { fileURLToPath } = require('node:url')

const root = join(__dirname, '..')
const pkg = require(join(root, 'package.json'))
const updaterPath = join(root, 'release', 'Updater', `VastUpdater-${pkg.version}.exe`)
const MAX_CERTIFICATE_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 5

function flag(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

function isPublicDistribution() {
  return ['beta', 'stable'].includes(process.env.VAST_RELEASE_CHANNEL) && !flag('VAST_PRIVATE_BUILD', true)
}

function isPublicUnsignedRelease() {
  return ['beta', 'stable'].includes(process.env.VAST_RELEASE_CHANNEL) &&
    !flag('VAST_PRIVATE_BUILD', true) &&
    flag('VAST_PUBLIC_UNSIGNED_RELEASE', false) &&
    String(process.env.VAST_UNSIGNED_RELEASE_ACK ?? '').trim() === 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
}

function findSignTool() {
  const configured = String(process.env.WINDOWS_SIGNTOOL_PATH ?? '').trim()
  if (configured) {
    const fullPath = isAbsolute(configured) ? configured : resolve(root, configured)
    if (!existsSync(fullPath)) throw new Error('WINDOWS_SIGNTOOL_PATH does not exist')
    return fullPath
  }

  const where = spawnSync('where.exe', ['signtool.exe'], { encoding: 'utf8', windowsHide: true })
  const fromPath = String(where.stdout ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && existsSync(entry))
  if (fromPath) return fromPath

  const kitsRoot = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  if (existsSync(kitsRoot)) {
    const candidates = readdirSync(kitsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => join(kitsRoot, entry.name, 'x64', 'signtool.exe'))
      .filter(existsSync)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (candidates[0]) return candidates[0]
  }

  throw new Error('signtool.exe was not found in PATH or the Windows 10 SDK')
}

function decodeBase64Certificate(value) {
  const normalized = value.replace(/^base64:/i, '').replace(/^data:[^,]+;base64,/i, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined
  const decoded = Buffer.from(normalized, 'base64')
  if (decoded.length < 4 || decoded.length > MAX_CERTIFICATE_BYTES) return undefined
  return decoded
}

async function downloadCertificate(initialUrl) {
  let current = new URL(initialUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:') throw new Error('Signing certificate downloads must use HTTPS')
    const response = await fetch(current, { redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      if (hop === MAX_REDIRECTS) throw new Error('Signing certificate URL exceeded the redirect limit')
      const location = response.headers.get('location')
      if (!location) throw new Error('Signing certificate redirect is missing Location')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`Signing certificate download failed with HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength > MAX_CERTIFICATE_BYTES) throw new Error('Signing certificate download is too large')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_CERTIFICATE_BYTES) throw new Error('Signing certificate download is too large')
    return body
  }
  throw new Error('Signing certificate download failed')
}

async function resolveCertificate(link, tempRoot) {
  const value = String(link ?? '').trim()
  if (!value) throw new Error('WIN_CSC_LINK or CSC_LINK is required')

  if (/^file:/i.test(value)) {
    const path = fileURLToPath(value)
    if (!existsSync(path)) throw new Error('Code-signing certificate file does not exist')
    return path
  }

  const localPath = isAbsolute(value) ? value : resolve(root, value)
  if (existsSync(localPath)) return localPath

  let bytes
  if (/^https:/i.test(value)) bytes = await downloadCertificate(value)
  else bytes = decodeBase64Certificate(value)
  if (!bytes) throw new Error('WIN_CSC_LINK must be a PFX path, HTTPS URL, or base64-encoded PFX')

  const path = join(tempRoot, 'vast-code-signing.pfx')
  writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

function runSignTool(signTool, certificatePath, password) {
  const timestampServer =
    String(process.env.WINDOWS_TIMESTAMP_SERVER ?? '').trim() || 'http://timestamp.digicert.com'
  const sign = spawnSync(
    signTool,
    [
      'sign',
      '/fd',
      'SHA256',
      '/td',
      'SHA256',
      '/tr',
      timestampServer,
      '/f',
      certificatePath,
      '/p',
      password,
      '/d',
      'Vast Browser',
      '/du',
      'https://github.com/vstxx/vast-public',
      updaterPath
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  )
  if (sign.error) throw sign.error
  if (sign.status !== 0) {
    throw new Error(`signtool failed to sign ${basename(updaterPath)}: ${sign.stderr || sign.stdout}`)
  }

  const verify = spawnSync(signTool, ['verify', '/pa', '/all', updaterPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (verify.error) throw verify.error
  if (verify.status !== 0) {
    throw new Error(`signtool could not verify ${basename(updaterPath)}: ${verify.stderr || verify.stdout}`)
  }
}

async function main() {
  if (isPublicUnsignedRelease()) {
    console.log('Skipped updater Authenticode signing for an explicitly acknowledged public unsigned release.')
    return
  }
  if (!isPublicDistribution()) {
    console.log('Skipped updater Authenticode signing for a non-public build.')
    return
  }
  if (process.platform !== 'win32') throw new Error('Public Windows signing must run on Windows')
  if (!existsSync(updaterPath) || !statSync(updaterPath).isFile()) {
    throw new Error(`Updater executable is missing: ${updaterPath}`)
  }

  const password = String(process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD || '')
  if (!password) throw new Error('WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD is required')

  const tempRoot = mkdtempSync(join(tmpdir(), 'vast-signing-'))
  try {
    const certificate = await resolveCertificate(process.env.WIN_CSC_LINK || process.env.CSC_LINK, tempRoot)
    runSignTool(findSignTool(), certificate, password)
    console.log(`Signed and verified ${basename(updaterPath)} with SHA-256 and an RFC 3161 timestamp.`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
