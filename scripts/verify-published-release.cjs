const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const { tmpdir } = require('node:os')
const { basename, join, resolve, sep } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(process.env.VAST_RELEASE_VERSION || pkg.version).trim()
const releaseRepo = String(process.env.VAST_RELEASE_REPO || 'vstxx/vast-public').trim()
const baseUrl = String(process.env.VAST_PRODUCTION_RELEASE_BASE_URL || `https://github.com/${releaseRepo}/releases/download/v${version}`).replace(/\/+$/, '')
const expectedSigner = String(process.env.VAST_EXPECTED_SIGNER_SUBJECT || '').trim()
const expectedSourceCommit = String(process.env.VAST_RELEASE_COMMIT || '').trim().toLowerCase()
const token = String(process.env.VAST_RELEASE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
const keepDownloads = process.argv.includes('--keep-downloads')
const skipLocalMatch = process.argv.includes('--skip-local-match')
const draftReleaseApi = process.env.VAST_GITHUB_DRAFT_RELEASE === '1'
const publicUnsignedBeta =
  process.env.VAST_RELEASE_CHANNEL === 'beta' &&
  ['1', 'true', 'yes', 'on'].includes(String(process.env.VAST_PUBLIC_UNSIGNED_BETA ?? '').trim().toLowerCase())
const maximumDownloadBytes = 3 * 1024 * 1024 * 1024
const tempRoot = mkdtempSync(join(tmpdir(), `vast-published-${version}-`))

const assets = [
  { name: `Vast-Setup-${version}.exe`, local: `Installer/Vast-Setup-${version}.exe`, signed: true },
  { name: `Vast-${version}-Portable.exe`, local: `Installer/Vast-${version}-Portable.exe`, signed: true },
  { name: `VastUpdater-${version}.exe`, local: `Updater/VastUpdater-${version}.exe`, signed: true },
  { name: 'update-manifest.json', local: 'Downloads/update-manifest.json' },
  { name: `Vast-${version}-update.zip`, local: `Downloads/Vast-${version}-update.zip` },
  { name: 'checksums.json', local: 'Checksums/checksums.json' },
  { name: 'SHA256SUMS.txt', local: 'Checksums/SHA256SUMS.txt' },
  { name: 'SHA512SUMS.txt', local: 'Checksums/SHA512SUMS.txt' },
  { name: 'release-manifest.json', local: 'Docs/release-manifest.json' },
  { name: 'version.json', local: 'version.json' }
]

if (publicUnsignedBeta) assets.push({ name: 'PUBLIC-UNSIGNED-BETA.md', local: 'PUBLIC-UNSIGNED-BETA.md' })

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function assertSafeVersion() {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
  }
  const parsed = new URL(`${baseUrl}/`)
  if (parsed.protocol !== 'https:') throw new Error('Published release verification requires an HTTPS production source.')
  if (!publicUnsignedBeta && !expectedSigner) throw new Error('VAST_EXPECTED_SIGNER_SUBJECT is required for a signed release.')
  if (publicUnsignedBeta && process.env.VAST_UNSIGNED_BETA_ACK !== 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK') {
    throw new Error('Public unsigned beta verification requires the exact risk acknowledgement.')
  }
  if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit)) throw new Error('VAST_RELEASE_COMMIT must be a full source commit SHA.')
}

async function releaseAssetUrls() {
  if (!draftReleaseApi) return new Map()
  if (!token) throw new Error('Draft release verification requires VAST_RELEASE_TOKEN, GH_TOKEN, or GITHUB_TOKEN.')
  const response = await fetch(`https://api.github.com/repos/${releaseRepo}/releases?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': `VastReleaseVerifier/${version}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!response.ok) throw new Error(`Could not resolve draft release assets: HTTP ${response.status}`)
  const releases = await response.json()
  const release = Array.isArray(releases)
    ? releases.find((candidate) => candidate?.draft === true && candidate?.tag_name === `v${version}`)
    : undefined
  if (!release) throw new Error(`Could not find draft release v${version} in ${releaseRepo}.`)
  return new Map((release.assets || []).map((asset) => [asset.name, asset.url]))
}

async function download(asset, apiUrls) {
  const target = join(tempRoot, asset.name)
  const sourceUrl = apiUrls.get(asset.name) || `${baseUrl}/${encodeURIComponent(asset.name)}`
  if (draftReleaseApi && !apiUrls.has(asset.name)) throw new Error(`Draft release asset is missing: ${asset.name}`)
  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': `VastReleaseVerifier/${version}`,
      ...(draftReleaseApi ? { Accept: 'application/octet-stream' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    signal: AbortSignal.timeout(10 * 60_000)
  })
  if (!response.ok || !response.body) throw new Error(`Production download failed for ${asset.name}: HTTP ${response.status}`)
  if (!response.url.startsWith('https://')) throw new Error(`Production download redirected outside HTTPS: ${asset.name}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maximumDownloadBytes) throw new Error(`Production asset is too large: ${asset.name}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: 'wx' }))
  const size = statSync(target).size
  if (size <= 0 || size > maximumDownloadBytes) throw new Error(`Production asset has an invalid size: ${asset.name}`)
  if (!skipLocalMatch) {
    const local = join(root, 'release', ...asset.local.split('/'))
    if (!existsSync(local)) throw new Error(`Local release asset is missing for comparison: ${asset.local}`)
    if (sha256(local) !== sha256(target)) throw new Error(`Production asset differs from the locally verified artifact: ${asset.name}`)
  }
  return target
}

function inspectAuthenticode(file) {
  if (process.platform !== 'win32') throw new Error('Authenticode verification requires Windows.')
  const script = [
    '$s = Get-AuthenticodeSignature -LiteralPath $env:VAST_SIGNATURE_PATH',
    '$r = [ordered]@{ Status=[string]$s.Status; Signer=[string]$s.SignerCertificate.Subject; Timestamp=[string]$s.TimeStamperCertificate.Subject }',
    '$r | ConvertTo-Json -Compress'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, VAST_SIGNATURE_PATH: file }, encoding: 'utf8', windowsHide: true
  })
  if (result.error || result.status !== 0) throw new Error(`Could not inspect Authenticode for ${basename(file)}.`)
  const signature = JSON.parse(String(result.stdout).trim())
  if (publicUnsignedBeta) {
    if (signature.Status !== 'NotSigned') throw new Error(`${basename(file)} must be intentionally NotSigned, got ${signature.Status}.`)
    return { file: basename(file), status: signature.Status, signer: '', timestamped: false }
  }
  if (signature.Status !== 'Valid') throw new Error(`${basename(file)} Authenticode status is ${signature.Status}.`)
  if (!String(signature.Timestamp || '').trim()) throw new Error(`${basename(file)} has no trusted timestamp.`)
  if (!String(signature.Signer || '').toLowerCase().includes(expectedSigner.toLowerCase())) {
    throw new Error(`${basename(file)} is not signed by ${expectedSigner}.`)
  }
  return { file: basename(file), signer: signature.Signer, timestamped: true }
}

function extractRuntime(zipFile, manifest) {
  const extractRoot = join(tempRoot, 'expanded')
  mkdirSync(extractRoot, { recursive: true })
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:VAST_ZIP_PATH -DestinationPath $env:VAST_EXTRACT_PATH -Force'
  ], { env: { ...process.env, VAST_ZIP_PATH: zipFile, VAST_EXTRACT_PATH: extractRoot }, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Could not extract the production update package: ${result.stderr || result.stdout}`)
  const payloadRelative = String(manifest.package?.payloadPath || '').replace(/\\/g, '/')
  if (!payloadRelative || payloadRelative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Production update manifest contains an unsafe payload path.')
  }
  const payload = resolve(extractRoot, ...payloadRelative.split('/'))
  if (!payload.startsWith(`${resolve(extractRoot)}${sep}`)) throw new Error('Production payload escapes its extraction root.')
  const runtime = join(payload, 'Vast.exe')
  if (!existsSync(runtime)) throw new Error('Production update package does not contain Vast.exe.')
  return runtime
}

async function main() {
  assertSafeVersion()
  const apiUrls = await releaseAssetUrls()
  const downloaded = new Map()
  for (const asset of assets) downloaded.set(asset.name, await download(asset, apiUrls))
  const manifest = JSON.parse(readFileSync(downloaded.get('update-manifest.json'), 'utf8').replace(/^\uFEFF/, ''))
  const releaseManifest = JSON.parse(readFileSync(downloaded.get('release-manifest.json'), 'utf8').replace(/^\uFEFF/, ''))
  const versionJson = JSON.parse(readFileSync(downloaded.get('version.json'), 'utf8').replace(/^\uFEFF/, ''))
  const zipName = `Vast-${version}-update.zip`
  const zip = downloaded.get(zipName)
  if (manifest.version !== version) throw new Error('Production update manifest version does not match the release.')
  if (manifest.sourceCommit !== expectedSourceCommit) throw new Error('Production update manifest sourceCommit does not match VAST_RELEASE_COMMIT.')
  const expectedSignaturePolicy = publicUnsignedBeta ? 'unsigned-public-beta' : 'authenticode-signed'
  if (manifest.signaturePolicy !== expectedSignaturePolicy) throw new Error('Production update manifest signaturePolicy is incorrect.')
  if (releaseManifest.version !== version || releaseManifest.sourceCommit !== expectedSourceCommit) {
    throw new Error('Production release manifest provenance does not match this version and source commit.')
  }
  if (releaseManifest.signaturePolicy !== expectedSignaturePolicy) throw new Error('Production release manifest signaturePolicy is incorrect.')
  if (versionJson.version !== version || versionJson.sourceCommit !== expectedSourceCommit) {
    throw new Error('Production version.json provenance does not match this version and source commit.')
  }
  if (versionJson.signaturePolicy !== expectedSignaturePolicy) throw new Error('Production version.json signaturePolicy is incorrect.')
  if (manifest.package?.url !== zipName) throw new Error('Production update manifest points at an unexpected package.')
  if (manifest.package?.sha256 !== sha256(zip)) throw new Error('Production update package SHA-256 does not match its manifest.')
  if (Number(manifest.package?.size) !== statSync(zip).size) throw new Error('Production update package size does not match its manifest.')

  const signatures = assets.filter((asset) => asset.signed).map((asset) => inspectAuthenticode(downloaded.get(asset.name)))
  signatures.push(inspectAuthenticode(extractRuntime(zip, manifest)))
  console.log(JSON.stringify({ ok: true, version, source: draftReleaseApi ? `${releaseRepo} draft release API` : baseUrl, signaturePolicy: expectedSignaturePolicy, downloaded: assets.map((asset) => asset.name), signatures }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(() => {
  if (keepDownloads) console.log(`Published verification downloads kept at ${tempRoot}`)
  else rmSync(tempRoot, { recursive: true, force: true })
})
