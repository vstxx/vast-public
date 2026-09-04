const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')
const { tmpdir } = require('node:os')
const { inspectTrustedAuthenticode, inspectUnsignedPe } = require('./windows-authenticode.cjs')

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
  'Docs/ffmpeg-build-provenance.json',
  'Docs/avidae-ffmpeg-capabilities.json',
  'Source/ffmpeg-corresponding-source-win64.tar.zst',
  'README.md',
  'version.json'
]

const failures = []

function fail(message) {
  failures.push(message)
}

function inspectUpdateArchive() {
  const archivePath = join(releaseRoot, 'Downloads', `Vast-${version}-update.zip`)
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'verify-update-archive.ps1'),
    '-ArchivePath', archivePath, '-Version', version
  ], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  })
  if (result.error || result.status !== 0) {
    fail(`update ZIP structural verification failed: ${result.error?.message || String(result.stderr || result.stdout || '').trim()}`)
    return undefined
  }
  try {
    const report = JSON.parse(String(result.stdout || '').trim())
    if (report.ok !== true || !Number.isSafeInteger(report.fileCount) || report.fileCount < 1) throw new Error('invalid archive report')
    return report
  } catch (error) {
    fail(`could not parse update ZIP structural verification: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function inspectFfmpegCompliance(runtimePath) {
  const result = spawnSync(process.execPath, [
    join(root, 'scripts', 'check-ffmpeg-release-compliance.cjs'),
    '--root', join(root, '.vast-build', 'ffmpeg'),
    '--runtime', runtimePath,
    '--source-bundle', join(releaseRoot, 'Source', 'ffmpeg-corresponding-source-win64.tar.zst')
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    fail(`packaged FFmpeg compliance verification failed: ${result.error?.message || String(result.stderr || result.stdout || '').trim()}`)
    return { verified: false }
  }
  return { verified: true }
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
const publicUnsignedRelease =
  publicDistributionFromEnv &&
  flagValue(process.env.VAST_PUBLIC_UNSIGNED_RELEASE, false)
const signedPublicDistribution = publicDistributionFromEnv && !publicUnsignedRelease
const expectedSignerSubject = String(process.env.VAST_EXPECTED_SIGNER_SUBJECT ?? '').trim()
const expectedSourceCommit = String(process.env.VAST_RELEASE_COMMIT ?? '').trim().toLowerCase()

if (publicUnsignedRelease) requiredFiles.push('PUBLIC-UNSIGNED-RELEASE.md')

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
    if (metadata.distributionChannel !== 'direct') fail('direct release package metadata must use distributionChannel=direct')
    if (metadata.releaseChannel !== process.env.VAST_RELEASE_CHANNEL) fail('packaged release metadata releaseChannel does not match the public build channel')
    if (metadata.privateBuild !== false) fail('packaged release metadata privateBuild must be false')
    if (metadata.updateEnabled !== true) fail('packaged release metadata updateEnabled must be true')
    if (metadata.obfuscationEnabled !== true) fail('packaged release metadata obfuscationEnabled must be true')
    if (metadata.releaseRepo !== 'vstxx/vast-public') fail('packaged release metadata releaseRepo must be vstxx/vast-public')
    if (metadata.relay?.enabled !== true) fail('packaged public metadata must enable Relay')
    if (metadata.relay?.environment !== 'production') fail('packaged public metadata Relay environment must be production')
    if (metadata.relay?.endpoint !== 'https://relay.vastbrowser.com') fail('packaged public metadata Relay endpoint must be production')
    if (metadata.relay?.keyId !== 'relay-2026-01') fail('packaged public metadata must pin the production Relay key')
    if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit)) fail('public distribution verification requires VAST_RELEASE_COMMIT')
    if (metadata.sourceCommit !== expectedSourceCommit) fail('packaged release metadata sourceCommit does not match VAST_RELEASE_COMMIT')
    const expectedSignaturePolicy = publicUnsignedRelease ? 'unsigned-public-release' : 'authenticode-signed'
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
    noticesKeyId: metadata.noticesKeyId,
    relay: metadata.relay
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
  try {
    const signature = signedPublicDistribution ? inspectTrustedAuthenticode(fullPath) : inspectUnsignedPe(fullPath)
    if (signedPublicDistribution && signature.status !== 'Valid') {
      fail(`signed public distribution artifact has invalid Authenticode status ${signature.status}: ${relativePath}`)
    }
    if (publicUnsignedRelease && signature.status !== 'NotSigned') {
      fail(`public unsigned release artifact must be NotSigned, got ${signature.status}: ${relativePath}`)
    }
    if (signedPublicDistribution && !signature.signerSubject) {
      fail(`signed public distribution artifact is missing a signer certificate: ${relativePath}`)
    }
    if (signedPublicDistribution && !signature.timestampSubject) {
      fail(`signed public distribution artifact is missing an RFC 3161 timestamp: ${relativePath}`)
    }
    if (signedPublicDistribution && expectedSignerSubject && !signature.signerSubject.toLowerCase().includes(expectedSignerSubject.toLowerCase())) {
      fail(`public distribution artifact signer does not match ${expectedSignerSubject}: ${relativePath}`)
    }
    return {
      required: signedPublicDistribution,
      status: signature.status,
      statusMessage: signature.statusMessage,
      signerSubject: signature.signerSubject,
      signerNotAfter: signature.signerNotAfter,
      timestampPresent: Boolean(signature.timestampSubject),
      timestampNotAfter: signature.timestampNotAfter
    }
  } catch (error) {
    fail(`could not inspect Authenticode for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

for (const relativePath of requiredFiles) assertFile(relativePath)
const updateArchive = inspectUpdateArchive()
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

const forbiddenBundledExtensionAsset = /(?:^|\/)first-party-extensions\/idu-plus(?:[-.\/]|$)|IDU-Plus-by-Vast|IDU-Plus-screenshot|idu-plus-logo|Otfits Grotesk|Audex-Regular|Aligra\.woff2|\.vext$/i
const forbiddenBundledExtensionSource = /IDU-Plus-by-Vast|IDU-Plus-screenshot|idu-plus-logo|first-party-extensions[\\/]idu-plus/i
const forbiddenBundledExtensionBinaryMarkers = [
  'IDU-Plus-by-Vast',
  'IDU-Plus-screenshot',
  'idu-plus-logo',
  'Otfits Grotesk',
  'Audex-Regular',
  'Aligra.woff2'
]

function inspectAsarForExcludedExtensions(appAsarPath, label) {
  const asar = require('@electron/asar')
  for (const entry of asar.listPackage(appAsarPath)) {
    const portablePath = String(entry).replace(/\\/g, '/')
    if (forbiddenBundledExtensionAsset.test(portablePath)) fail(`${label} contains forbidden bundled extension asset: ${portablePath}`)
    if (/\.(?:c?js|mjs|html?|json|ya?ml)$/i.test(portablePath)) {
      const source = asar.extractFile(appAsarPath, String(entry).replace(/^\\/, '')).toString('utf8')
      if (forbiddenBundledExtensionSource.test(source)) fail(`${label} contains excluded extension runtime code in ${portablePath}`)
    }
  }
}

function inspectArtifactBytesForExcludedExtensions(artifact, label) {
  const fd = openSync(artifact, 'r')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  let carry = Buffer.alloc(0)
  let position = 0
  try {
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
      const latin1 = data.toString('latin1').toLowerCase()
      for (const marker of forbiddenBundledExtensionBinaryMarkers) {
        if (latin1.includes(marker.toLowerCase()) || data.includes(Buffer.from(marker, 'utf16le'))) {
          fail(`${label} contains forbidden bundled extension marker: ${marker}`)
        }
      }
      carry = data.subarray(Math.max(0, data.length - 256))
    }
  } finally {
    closeSync(fd)
  }
}

function inspectReleaseArtifactForExcludedExtensions(relativePath, { extractionRequired = true } = {}) {
  const artifact = join(releaseRoot, relativePath)
  if (!existsSync(artifact)) return
  inspectArtifactBytesForExcludedExtensions(artifact, relativePath)
  const extractionRoot = mkdtempSync(join(tmpdir(), 'vast-release-exclusion-audit-'))
  try {
    const sevenZip = require('7zip-bin').path7za
    const extraction = spawnSync(sevenZip, ['x', '-y', `-o${extractionRoot}`, artifact], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 })
    if (extraction.error || extraction.status !== 0) {
      if (extractionRequired) {
        fail(`could not inspect ${relativePath} for excluded extension assets: ${extraction.error?.message || String(extraction.stderr || extraction.stdout).trim()}`)
      }
      return
    }
    for (const nestedArchive of listFiles(extractionRoot).filter((path) => /(?:app-\d+\.7z|\.zip)$/i.test(path))) {
      const nestedRoot = `${nestedArchive}.expanded`
      const nested = spawnSync(sevenZip, ['x', '-y', `-o${nestedRoot}`, nestedArchive], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 })
      if (nested.error || nested.status !== 0) fail(`could not inspect nested archive in ${relativePath}: ${nested.error?.message || String(nested.stderr || nested.stdout).trim()}`)
    }
    for (const fullPath of listFiles(extractionRoot)) {
      const portablePath = relative(extractionRoot, fullPath).replace(/\\/g, '/')
      if (forbiddenBundledExtensionAsset.test(portablePath)) fail(`${relativePath} contains forbidden bundled extension asset: ${portablePath}`)
      if (portablePath.endsWith('/resources/app.asar')) inspectAsarForExcludedExtensions(fullPath, relativePath)
      if (/\.(?:json|ya?ml)$/i.test(portablePath) && statSync(fullPath).size <= 4 * 1024 * 1024) {
        const text = readFileSync(fullPath, 'utf8')
        if (/first-party-extensions[\\/]idu-plus|IDU-Plus-by-Vast/i.test(text)) fail(`${relativePath} contains excluded extension metadata in ${portablePath}`)
      }
    }
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true })
  }
}

const packagedResourcesRoot = join(releaseRoot, `Vast-${version}`, 'win-unpacked', 'resources')
const ffmpegCompliance = inspectFfmpegCompliance(join(packagedResourcesRoot, 'avidae-runtime'))
const appUpdateConfigPath = join(packagedResourcesRoot, 'app-update.yml')
if (!existsSync(appUpdateConfigPath)) fail('packaged runtime is missing resources/app-update.yml required by electron-updater')
if (existsSync(appUpdateConfigPath)) {
  const appUpdateConfig = readFileSync(appUpdateConfigPath, 'utf8')
  if (!appUpdateConfig.includes('provider: github') || !appUpdateConfig.includes('owner: vstxx') || !appUpdateConfig.includes('repo: vast-public')) {
    fail('packaged resources/app-update.yml does not target the approved public update repository')
  }
}
if (existsSync(join(packagedResourcesRoot, 'cat-addon'))) {
  fail('distribution package contains removed Cat Addon resources')
}
if (publicDistributionFromEnv) {
  for (const fullPath of listFiles(join(releaseRoot, `Vast-${version}`))) {
    const portablePath = relative(releaseRoot, fullPath).replace(/\\/g, '/')
    if (forbiddenBundledExtensionAsset.test(portablePath)) fail(`distribution contains forbidden bundled extension asset: ${portablePath}`)
  }
  const appAsarPath = join(packagedResourcesRoot, 'app.asar')
  if (existsSync(appAsarPath)) {
    try { inspectAsarForExcludedExtensions(appAsarPath, 'public app.asar') } catch (error) { fail(`could not audit app.asar for IDU+ assets: ${error instanceof Error ? error.message : String(error)}`) }
  }
  for (const artifact of [`Installer/Vast-Setup-${version}.exe`, `Installer/Vast-${version}-Portable.exe`, `Downloads/Vast-${version}-update.zip`]) {
    inspectReleaseArtifactForExcludedExtensions(artifact)
  }
  inspectReleaseArtifactForExcludedExtensions(`Updater/VastUpdater-${version}.exe`, { extractionRequired: false })
}
if (publicDistributionFromEnv && existsSync(join(releaseRoot, 'INTERNAL-UNSIGNED.md'))) {
  fail('public distribution contains the internal unsigned marker')
}
if (publicDistributionFromEnv && existsSync(join(releaseRoot, 'PUBLIC-UNSIGNED-BETA.md'))) {
  fail('public distribution contains the obsolete public unsigned beta marker')
}
if (signedPublicDistribution && existsSync(join(releaseRoot, 'PUBLIC-UNSIGNED-RELEASE.md'))) {
  fail('signed public distribution contains the public unsigned release marker')
}
if (publicUnsignedRelease && !existsSync(join(releaseRoot, 'PUBLIC-UNSIGNED-RELEASE.md'))) {
  fail('public unsigned release is missing PUBLIC-UNSIGNED-RELEASE.md')
}
if (publicUnsignedRelease && process.env.VAST_UNSIGNED_RELEASE_ACK !== 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK') {
  fail('public unsigned release verification requires the exact risk acknowledgement')
}
if (signedPublicDistribution && !expectedSignerSubject) {
  fail('signed public distribution verification requires VAST_EXPECTED_SIGNER_SUBJECT')
}

if (existsSync(join(releaseRoot, 'version.json'))) {
  const versionJson = readJson('version.json')
  if (versionJson.version !== version) fail('release/version.json version does not match package.json')
  if (publicDistributionFromEnv && versionJson.sourceCommit !== expectedSourceCommit) fail('release/version.json sourceCommit does not match VAST_RELEASE_COMMIT')
  if (publicDistributionFromEnv && versionJson.signaturePolicy !== (publicUnsignedRelease ? 'unsigned-public-release' : 'authenticode-signed')) fail('release/version.json signaturePolicy is incorrect')
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
  if (publicDistributionFromEnv && manifest.signaturePolicy !== (publicUnsignedRelease ? 'unsigned-public-release' : 'authenticode-signed')) fail('download manifest signaturePolicy is incorrect')
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
  if (publicDistributionFromEnv && releaseManifest.signaturePolicy !== (publicUnsignedRelease ? 'unsigned-public-release' : 'authenticode-signed')) fail('release manifest signaturePolicy is incorrect')
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
  publicUnsignedRelease,
  signaturePolicy: publicUnsignedRelease ? 'unsigned-public-release' : (signedPublicDistribution ? 'authenticode-signed' : 'internal-unsigned'),
  releaseRoot,
  requiredFiles,
  packagedBuildMetadata,
  obfuscation,
  electronFuses,
  ffmpegCompliance,
  updateArchive,
  authenticode,
  failures
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exit(1)
