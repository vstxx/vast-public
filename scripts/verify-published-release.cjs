const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const { tmpdir } = require('node:os')
const { basename, join, resolve, sep } = require('node:path')
const { inspectTrustedAuthenticode, inspectUnsignedPe } = require('./windows-authenticode.cjs')

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
const legacyPublicUnsignedBeta =
  process.env.VAST_RELEASE_CHANNEL === 'beta' &&
  ['1', 'true', 'yes', 'on'].includes(String(process.env.VAST_PUBLIC_UNSIGNED_BETA ?? '').trim().toLowerCase())
const publicUnsignedRelease =
  ['beta', 'stable'].includes(process.env.VAST_RELEASE_CHANNEL) &&
  ['1', 'true', 'yes', 'on'].includes(String(process.env.VAST_PUBLIC_UNSIGNED_RELEASE ?? '').trim().toLowerCase())
const unsignedPublicDistribution = legacyPublicUnsignedBeta || publicUnsignedRelease
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
  { name: 'ffmpeg-build-provenance.json', local: 'Docs/ffmpeg-build-provenance.json' },
  { name: 'avidae-ffmpeg-capabilities.json', local: 'Docs/avidae-ffmpeg-capabilities.json' },
  { name: 'ffmpeg-corresponding-source-win64.tar.zst', local: 'Source/ffmpeg-corresponding-source-win64.tar.zst' },
  { name: 'version.json', local: 'version.json' }
]

if (legacyPublicUnsignedBeta) assets.push({ name: 'PUBLIC-UNSIGNED-BETA.md', local: 'PUBLIC-UNSIGNED-BETA.md' })
if (publicUnsignedRelease) assets.push({ name: 'PUBLIC-UNSIGNED-RELEASE.md', local: 'PUBLIC-UNSIGNED-RELEASE.md' })

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function assertSafeVersion() {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
  }
  const parsed = new URL(`${baseUrl}/`)
  if (parsed.protocol !== 'https:') throw new Error('Published release verification requires an HTTPS production source.')
  if (!unsignedPublicDistribution && !expectedSigner) throw new Error('VAST_EXPECTED_SIGNER_SUBJECT is required for a signed release.')
  if (legacyPublicUnsignedBeta && process.env.VAST_UNSIGNED_BETA_ACK !== 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK') {
    throw new Error('Public unsigned beta verification requires the exact risk acknowledgement.')
  }
  if (publicUnsignedRelease && process.env.VAST_UNSIGNED_RELEASE_ACK !== 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK') {
    throw new Error('Public unsigned release verification requires the exact risk acknowledgement.')
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

async function publicSourceFile(path) {
  const response = await fetch(`https://api.github.com/repos/${releaseRepo}/contents/${path}?ref=${encodeURIComponent(`v${version}`)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `VastReleaseVerifier/${version}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  })
  if (!response.ok) throw new Error(`Public source tag is missing ${path}: HTTP ${response.status}`)
  const body = await response.json()
  if (body?.encoding !== 'base64' || typeof body.content !== 'string') throw new Error(`Public source tag returned malformed ${path}.`)
  return JSON.parse(Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8'))
}

async function verifyPublicSourceTag() {
  const [sourcePackage, provenance] = await Promise.all([
    publicSourceFile('package.json'),
    publicSourceFile('.vast-source-provenance.json')
  ])
  if (sourcePackage.version !== version) throw new Error(`Public tag v${version} exposes package.json version ${sourcePackage.version}.`)
  if (provenance.version !== version || provenance.sourceCommit !== expectedSourceCommit) {
    throw new Error(`Public tag v${version} does not correspond to the released source commit.`)
  }
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
  const signature = unsignedPublicDistribution ? inspectUnsignedPe(file) : inspectTrustedAuthenticode(file)
  if (unsignedPublicDistribution) {
    if (signature.status !== 'NotSigned') throw new Error(`${basename(file)} must be intentionally NotSigned, got ${signature.status}.`)
    return { file: basename(file), status: signature.status, signer: '', timestamped: false }
  }
  if (signature.status !== 'Valid') throw new Error(`${basename(file)} Authenticode status is ${signature.status}.`)
  if (!String(signature.timestampSubject || '').trim()) throw new Error(`${basename(file)} has no trusted timestamp.`)
  if (!String(signature.signerSubject || '').toLowerCase().includes(expectedSigner.toLowerCase())) {
    throw new Error(`${basename(file)} is not signed by ${expectedSigner}.`)
  }
  return { file: basename(file), signer: signature.signerSubject, timestamped: true }
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
  return { runtime, payload }
}

async function main() {
  assertSafeVersion()
  await verifyPublicSourceTag()
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
  const expectedSignaturePolicy = legacyPublicUnsignedBeta
    ? 'unsigned-public-beta'
    : (publicUnsignedRelease ? 'unsigned-public-release' : 'authenticode-signed')
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
  const ffmpegProvenance = JSON.parse(readFileSync(downloaded.get('ffmpeg-build-provenance.json'), 'utf8'))
  const ffmpegCapabilities = downloaded.get('avidae-ffmpeg-capabilities.json')
  const sourceBundle = downloaded.get('ffmpeg-corresponding-source-win64.tar.zst')
  if (ffmpegProvenance.sourceBundle?.sha256 !== sha256(sourceBundle) || ffmpegProvenance.sourceBundle?.size !== statSync(sourceBundle).size) {
    throw new Error('Published FFmpeg corresponding source does not match published provenance.')
  }
  if (ffmpegProvenance.capabilityReport?.sha256 !== sha256(ffmpegCapabilities) || ffmpegProvenance.capabilityReport?.size !== statSync(ffmpegCapabilities).size) {
    throw new Error('Published FFmpeg capability report does not match published provenance.')
  }

  const signatures = assets.filter((asset) => asset.signed).map((asset) => inspectAuthenticode(downloaded.get(asset.name)))
  const extracted = extractRuntime(zip, manifest)
  signatures.push(inspectAuthenticode(extracted.runtime))
  const compliance = spawnSync(process.execPath, [
    join(root, 'scripts', 'check-ffmpeg-release-compliance.cjs'),
    '--root', join(root, '.vast-build', 'ffmpeg'),
    '--runtime', join(extracted.payload, 'resources', 'avidae-runtime'),
    '--source-bundle', sourceBundle
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  if (compliance.error || compliance.status !== 0) throw new Error(`Published FFmpeg compliance gate failed: ${compliance.error?.message || compliance.stderr || compliance.stdout}`)
  console.log(JSON.stringify({ ok: true, version, source: draftReleaseApi ? `${releaseRepo} draft release API` : baseUrl, signaturePolicy: expectedSignaturePolicy, downloaded: assets.map((asset) => asset.name), signatures }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}).finally(() => {
  if (keepDownloads) console.log(`Published verification downloads kept at ${tempRoot}`)
  else rmSync(tempRoot, { recursive: true, force: true })
})
