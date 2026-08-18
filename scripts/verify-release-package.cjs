const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const releaseRoot = join(root, 'release')

const requiredFiles = [
  `Installer/Vast-Setup-${version}.exe`,
  `Installer/Vast-Setup-${version}.exe.blockmap`,
  `Installer/Vast-${version}-Portable.exe`,
  'Installer/latest.yml',
  `Updater/VastUpdater-${version}.exe`,
  'Downloads/update-manifest.json',
  `Downloads/Vast-${version}-update.zip`,
  'Checksums/SHA256SUMS.txt',
  'Checksums/SHA512SUMS.txt',
  'Checksums/checksums.json',
  'Docs/release-manifest.json',
  'Docs/data-migration-and-storage.md',
  'README.md',
  'version.json'
]

const failures = []

function fail(message) {
  failures.push(message)
}

function inspectElectronFuses(relativePath) {
  const executable = join(releaseRoot, relativePath)
  if (!existsSync(executable)) {
    fail(`missing packaged Electron runtime for fuse verification: ${relativePath}`)
    return { verified: false }
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-electron-fuses.cjs'), executable], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    fail(`Electron fuse verification failed for ${relativePath}: ${String(result.stderr || result.stdout).trim()}`)
    return { verified: false }
  }
  return { verified: true }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(releaseRoot, relativePath), 'utf8').replace(/^\uFEFF/, ''))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function flagValue(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

const publicDistributionFromEnv =
  ['beta', 'stable'].includes(process.env.VAST_RELEASE_CHANNEL) && !flagValue(process.env.VAST_PRIVATE_BUILD, true)
const publicUnsignedBeta =
  publicDistributionFromEnv &&
  process.env.VAST_RELEASE_CHANNEL === 'beta' &&
  flagValue(process.env.VAST_PUBLIC_UNSIGNED_BETA, false)
const signedPublicDistribution = publicDistributionFromEnv && !publicUnsignedBeta
const expectedSignerSubject = String(process.env.VAST_EXPECTED_SIGNER_SUBJECT ?? '').trim()
const expectedSourceCommit = String(process.env.VAST_RELEASE_COMMIT ?? '').trim().toLowerCase()

if (publicUnsignedBeta) requiredFiles.push('PUBLIC-UNSIGNED-BETA.md')

function listFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) return listFiles(fullPath)
    if (entry.isFile()) return [fullPath]
    return []
  })
}

function assertFile(relativePath) {
  const fullPath = join(releaseRoot, relativePath)
  if (!existsSync(fullPath)) {
    fail(`missing required release file: ${relativePath}`)
    return
  }
  if (!statSync(fullPath).isFile()) fail(`required release path is not a file: ${relativePath}`)
}

function assertWindowsExe(relativePath) {
  const fullPath = join(releaseRoot, relativePath)
  if (!existsSync(fullPath)) return

  const stat = statSync(fullPath)
  const header = Buffer.alloc(2)
  const fd = openSync(fullPath, 'r')
  try {
    readSync(fd, header, 0, 2, 0)
  } finally {
    closeSync(fd)
  }
  if (header[0] !== 0x4d || header[1] !== 0x5a) fail(`${relativePath} is not a Windows MZ executable`)
  if (stat.size < 1024 * 1024) fail(`${relativePath} is too small to be a real packaged executable`)
}

function readPackagedAsarFile(relativePath) {
  const appAsarPath = join(releaseRoot, `Vast-${version}`, 'win-unpacked', 'resources', 'app.asar')
  if (!existsSync(appAsarPath)) {
    fail(`missing packaged app.asar: ${relative(releaseRoot, appAsarPath).replace(/\\/g, '/')}`)
    return undefined
  }

  try {
    const asar = require('@electron/asar')
    return asar.extractFile(appAsarPath, relativePath.replace(/\//g, '\\')).toString('utf8')
  } catch (error) {
    fail(`could not read ${relativePath} from packaged app.asar: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function assertReleaseBuildMetadata() {
  const metadataText = readPackagedAsarFile('out/release-build-metadata.json')
  if (!metadataText) return undefined

  let metadata
  try {
    metadata = JSON.parse(metadataText.replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`packaged release-build-metadata.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  if (metadata.productName !== 'Vast') fail('packaged release metadata productName must be Vast')
  if (metadata.version !== version) fail('packaged release metadata version does not match package.json')
  if (metadata.noticesEnabled === true) {
    if (typeof metadata.noticesFeedOrigin !== 'string' || !metadata.noticesFeedOrigin.startsWith('https://')) {
      fail('packaged Vast Notices metadata must contain an HTTPS feed origin')
    }
    if (metadata.noticesFeedOrigin === 'https://github.com' || metadata.noticesFeedOrigin === 'https://api.github.com') {
      fail('packaged Vast Notices metadata must not share the updater trust origin')
    }
    if (typeof metadata.noticesKeyId !== 'string' || metadata.noticesKeyId.length === 0) {
      fail('packaged Vast Notices metadata must identify its pinned signing key')
    }
  }

  if (publicDistributionFromEnv) {
    if (metadata.releaseChannel !== process.env.VAST_RELEASE_CHANNEL) fail('packaged release metadata releaseChannel does not match the public build channel')
    if (metadata.privateBuild !== false) fail('packaged release metadata privateBuild must be false')
    if (metadata.updateEnabled !== true) fail('packaged release metadata updateEnabled must be true')
    if (metadata.obfuscationEnabled !== true) fail('packaged release metadata obfuscationEnabled must be true')
    if (metadata.releaseRepo !== 'vstxx/vast-public') fail('packaged release metadata releaseRepo must be vstxx/vast-public')
    if (metadata.releaseChannel === 'beta' && metadata.catAddonIncluded !== false) fail('packaged beta metadata must exclude Cat Addon')
    if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit)) fail('public distribution verification requires VAST_RELEASE_COMMIT')
    if (metadata.sourceCommit !== expectedSourceCommit) fail('packaged release metadata sourceCommit does not match VAST_RELEASE_COMMIT')
    const expectedSignaturePolicy = publicUnsignedBeta ? 'unsigned-public-beta' : 'authenticode-signed'
    if (metadata.signaturePolicy !== expectedSignaturePolicy) fail(`packaged release metadata signaturePolicy must be ${expectedSignaturePolicy}`)
  }

  return {
    present: true,
    releaseChannel: metadata.releaseChannel,
    privateBuild: metadata.privateBuild,
    updateEnabled: metadata.updateEnabled,
    obfuscationEnabled: metadata.obfuscationEnabled,
    releaseRepo: metadata.releaseRepo,
    sourceCommit: metadata.sourceCommit,
    signaturePolicy: metadata.signaturePolicy,
    noticesEnabled: metadata.noticesEnabled === true,
    noticesFeedOrigin: metadata.noticesFeedOrigin,
    noticesKeyId: metadata.noticesKeyId
  }
}

function assertObfuscationReport() {
  const reportText = readPackagedAsarFile('out/obfuscation-report.json')
  if (!reportText) return undefined

  let report
  try {
    report = JSON.parse(reportText.replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`packaged obfuscation-report.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  const files = Array.isArray(report.files) ? report.files : []
  const protectedFiles = files.filter((file) => file?.profile && file.profile !== 'none')
  if (report.strategy !== 'startup-selective-v1') fail('packaged obfuscation report has an unknown strategy')
  if (!protectedFiles.some((file) => String(file.file ?? '').replace(/\\/g, '/').startsWith('out/main/'))) {
    fail('packaged obfuscation report does not include protected main-process code')
  }
  if (!protectedFiles.some((file) => /^PasswordsPage-/i.test(String(file.file ?? '').split(/[\\/]/).pop() ?? ''))) {
    fail('packaged obfuscation report does not include the password-manager renderer bundle')
  }

  return {
    present: true,
    strategy: report.strategy,
    protectedFileCount: protectedFiles.length,
    totalFileCount: files.length
  }
}

function inspectAuthenticode(relativePath) {
  const fullPath = join(releaseRoot, relativePath)
  if (!existsSync(fullPath)) return undefined
  if (process.platform !== 'win32') {
    if (signedPublicDistribution) fail(`cannot verify Authenticode outside Windows: ${relativePath}`)
    return { required: false, status: 'NotChecked' }
  }

  const command = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:VAST_SIGNATURE_PATH',
    '$result = [ordered]@{',
    '  Status = [string]$signature.Status',
    '  StatusMessage = [string]$signature.StatusMessage',
    '  SignerSubject = [string]$signature.SignerCertificate.Subject',
    '  SignerNotAfter = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString("o") } else { "" })',
    '  TimestampSubject = [string]$signature.TimeStamperCertificate.Subject',
    '  TimestampNotAfter = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.NotAfter.ToUniversalTime().ToString("o") } else { "" })',
    '} | ConvertTo-Json -Compress'
  ].join('\n').replace('} | ConvertTo-Json', '}\n$result | ConvertTo-Json')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: root,
    env: { ...process.env, VAST_SIGNATURE_PATH: fullPath },
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error || result.status !== 0) {
    fail(`could not inspect Authenticode for ${relativePath}: ${result.error?.message || result.stderr || result.stdout}`)
    return undefined
  }

  try {
    const signature = JSON.parse(String(result.stdout).trim())
    if (signedPublicDistribution && signature.Status !== 'Valid') {
      fail(`signed public distribution artifact has invalid Authenticode status ${signature.Status}: ${relativePath}`)
    }
    if (publicUnsignedBeta && signature.Status !== 'NotSigned') {
      fail(`public unsigned beta artifact must be NotSigned, got ${signature.Status}: ${relativePath}`)
    }
    if (signedPublicDistribution && !signature.SignerSubject) {
      fail(`signed public distribution artifact is missing a signer certificate: ${relativePath}`)
    }
    if (signedPublicDistribution && !signature.TimestampSubject) {
      fail(`signed public distribution artifact is missing an RFC 3161 timestamp: ${relativePath}`)
    }
    if (signedPublicDistribution && expectedSignerSubject && !signature.SignerSubject.toLowerCase().includes(expectedSignerSubject.toLowerCase())) {
      fail(`public distribution artifact signer does not match ${expectedSignerSubject}: ${relativePath}`)
    }
    return {
      required: signedPublicDistribution,
      status: signature.Status,
      statusMessage: signature.StatusMessage,
      signerSubject: signature.SignerSubject,
      signerNotAfter: signature.SignerNotAfter,
      timestampPresent: Boolean(signature.TimestampSubject),
      timestampNotAfter: signature.TimestampNotAfter
    }
  } catch (error) {
    fail(`could not parse Authenticode inspection for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

for (const relativePath of requiredFiles) assertFile(relativePath)
assertWindowsExe(`Installer/Vast-Setup-${version}.exe`)
assertWindowsExe(`Installer/Vast-${version}-Portable.exe`)
assertWindowsExe(`Updater/VastUpdater-${version}.exe`)
const packagedBuildMetadata = assertReleaseBuildMetadata()
const obfuscation = assertObfuscationReport()
const electronFuses = inspectElectronFuses(`Vast-${version}/win-unpacked/Vast.exe`)
const authenticode = {
  installer: inspectAuthenticode(`Installer/Vast-Setup-${version}.exe`),
  portable: inspectAuthenticode(`Installer/Vast-${version}-Portable.exe`),
  updater: inspectAuthenticode(`Updater/VastUpdater-${version}.exe`),
  runtime: inspectAuthenticode(`Vast-${version}/win-unpacked/Vast.exe`)
}

const packagedResourcesRoot = join(releaseRoot, `Vast-${version}`, 'win-unpacked', 'resources')
if (publicDistributionFromEnv && process.env.VAST_RELEASE_CHANNEL === 'beta' && existsSync(join(packagedResourcesRoot, 'cat-addon'))) {
  fail('public beta package contains Cat Addon resources')
}
if (publicDistributionFromEnv && existsSync(join(releaseRoot, 'INTERNAL-UNSIGNED.md'))) {
  fail('public distribution contains the internal unsigned marker')
}
if (signedPublicDistribution && existsSync(join(releaseRoot, 'PUBLIC-UNSIGNED-BETA.md'))) {
  fail('signed public distribution contains the public unsigned beta marker')
}
if (publicUnsignedBeta && !existsSync(join(releaseRoot, 'PUBLIC-UNSIGNED-BETA.md'))) {
  fail('public unsigned beta is missing PUBLIC-UNSIGNED-BETA.md')
}
if (publicUnsignedBeta && process.env.VAST_UNSIGNED_BETA_ACK !== 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK') {
  fail('public unsigned beta verification requires the exact risk acknowledgement')
}
if (signedPublicDistribution && !expectedSignerSubject) {
  fail('signed public distribution verification requires VAST_EXPECTED_SIGNER_SUBJECT')
}

if (existsSync(join(releaseRoot, 'version.json'))) {
  const versionJson = readJson('version.json')
  if (versionJson.version !== version) fail('release/version.json version does not match package.json')
  if (publicDistributionFromEnv && versionJson.sourceCommit !== expectedSourceCommit) fail('release/version.json sourceCommit does not match VAST_RELEASE_COMMIT')
  if (publicDistributionFromEnv && versionJson.signaturePolicy !== (publicUnsignedBeta ? 'unsigned-public-beta' : 'authenticode-signed')) fail('release/version.json signaturePolicy is incorrect')
  if ('edition' in versionJson) fail('release/version.json must not generate edition metadata')
  if (versionJson.updater && 'targetEdition' in versionJson.updater) fail('release updater metadata must not generate targetEdition')
  if (String(versionJson.updater?.entrypoint ?? '') !== `Updater/VastUpdater-${version}.exe`) {
    fail('release updater entrypoint must point at the versioned updater EXE')
  }
}

if (existsSync(join(releaseRoot, 'Downloads/update-manifest.json'))) {
  const manifest = readJson('Downloads/update-manifest.json')
  const zipRelative = `Downloads/Vast-${version}-update.zip`
  const zipPath = join(releaseRoot, zipRelative)
  if (manifest.version !== version) fail('download manifest version does not match package.json')
  if (publicDistributionFromEnv && manifest.sourceCommit !== expectedSourceCommit) fail('download manifest sourceCommit does not match VAST_RELEASE_COMMIT')
  if (publicDistributionFromEnv && manifest.signaturePolicy !== (publicUnsignedBeta ? 'unsigned-public-beta' : 'authenticode-signed')) fail('download manifest signaturePolicy is incorrect')
  if ('edition' in manifest) fail('download manifest must not generate edition metadata')
  if (manifest.package && 'edition' in manifest.package) fail('download manifest package must not generate edition metadata')
  if (manifest.package?.url !== `Vast-${version}-update.zip`) fail('download manifest package URL is not the expected update ZIP')
  if (existsSync(zipPath)) {
    const stat = statSync(zipPath)
    if (manifest.package?.sha256 !== sha256(zipPath)) fail('download manifest SHA-256 does not match update ZIP')
    if (Number(manifest.package?.size) !== stat.size) fail('download manifest size does not match update ZIP')
  }
}

if (existsSync(join(releaseRoot, 'Docs/release-manifest.json'))) {
  const releaseManifest = readJson('Docs/release-manifest.json')
  if (releaseManifest.version !== version) fail('release manifest version does not match package.json')
  if (publicDistributionFromEnv && releaseManifest.sourceCommit !== expectedSourceCommit) fail('release manifest sourceCommit does not match VAST_RELEASE_COMMIT')
  if (publicDistributionFromEnv && releaseManifest.signaturePolicy !== (publicUnsignedBeta ? 'unsigned-public-beta' : 'authenticode-signed')) fail('release manifest signaturePolicy is incorrect')
}

if (existsSync(join(releaseRoot, 'Installer/latest.yml'))) {
  const latestYml = readFileSync(join(releaseRoot, 'Installer/latest.yml'), 'utf8')
  if (!new RegExp(`version:\\s*${version.replace(/\./g, '\\.')}`).test(latestYml)) {
    fail('Installer/latest.yml does not target the package version')
  }
  if (!latestYml.includes(`Vast-Setup-${version}.exe`)) fail('Installer/latest.yml does not reference the setup EXE')
}

const releaseFiles = listFiles(releaseRoot)

const secretMarkers = [
  /-----BEGIN PRIVATE KEY-----/,
  /WIN_CSC_KEY_PASSWORD/,
  /CSC_KEY_PASSWORD/
]
const forbiddenProductBackendMarkers = [
  ['supa', 'base', '.co'].join(''),
  ['VAST', 'LICENSE'].join('_'),
  ['vast', 'license'].join(':')
]

const forbiddenReleaseFiles = new Set([
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'Updater/VastUpdater.cmd'
])

for (const file of releaseFiles) {
  const relativePath = relative(releaseRoot, file).replace(/\\/g, '/')
  if (forbiddenReleaseFiles.has(relativePath)) fail(`release package contains staging-only file: ${relativePath}`)
  if (!/\.(json|md|txt|yml|yaml|config)$/i.test(relativePath)) continue
  const text = readFileSync(file, 'utf8')
  for (const marker of secretMarkers) {
    if (marker.test(text)) fail(`release package text file contains secret marker ${marker}: ${relativePath}`)
  }
  for (const marker of forbiddenProductBackendMarkers) {
    if (text.toLowerCase().includes(marker.toLowerCase())) fail(`release package text file contains removed product-backend marker: ${relativePath}`)
  }
}

const appAsarPath = join(releaseRoot, `Vast-${version}`, 'win-unpacked', 'resources', 'app.asar')
if (existsSync(appAsarPath)) {
  const appAsarText = readFileSync(appAsarPath, 'latin1')
  for (const marker of secretMarkers) {
    if (marker.test(appAsarText)) fail(`packaged app.asar contains secret marker ${marker}`)
  }
  for (const marker of forbiddenProductBackendMarkers) {
    if (appAsarText.toLowerCase().includes(marker.toLowerCase())) fail('packaged app.asar contains removed product-backend code')
  }
}

const report = {
  ok: failures.length === 0,
  version,
  publicUnsignedBeta,
  signaturePolicy: publicUnsignedBeta ? 'unsigned-public-beta' : (signedPublicDistribution ? 'authenticode-signed' : 'internal-unsigned'),
  releaseRoot,
  requiredFiles,
  packagedBuildMetadata,
  obfuscation,
  electronFuses,
  authenticode,
  failures
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exit(1)
