const { createHash } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, dirname, join, relative, resolve } = require('node:path')
const {
  identityFromEnv,
  msixVersionForSemver,
  packageVersion,
  root,
  STORE_DISPLAY_NAME
} = require('./store-msix-config.cjs')
const { windowsSdkTool } = require('./store-msix-tools.cjs')

const input = process.argv[2]
const development = process.argv.includes('--development')
const requireSignature = process.argv.includes('--require-signature')
if (!input) throw new Error('Usage: node scripts/verify-store-msix.cjs <package.msix> [--development] [--require-signature]')
const packagePath = resolve(process.cwd(), input)
if (!existsSync(packagePath)) throw new Error(`MSIX package was not found: ${packagePath}`)

function allFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? allFiles(path) : entry.isFile() ? [path] : []
  })
}

function manifestAttribute(source, element, attribute) {
  const elementMatch = new RegExp(`<${element}\\b[^>]*>`, 'i').exec(source)
  if (!elementMatch) throw new Error(`MSIX manifest is missing ${element}.`)
  const attributeMatch = new RegExp(`\\b${attribute}="([^"]+)"`, 'i').exec(elementMatch[0])
  if (!attributeMatch) throw new Error(`MSIX manifest ${element} is missing ${attribute}.`)
  return attributeMatch[1]
}

function pngDimensions(path) {
  const bytes = readFileSync(path)
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${basename(path)} is not a PNG.`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function assertX64Pe(path) {
  const bytes = readFileSync(path)
  if (bytes.length < 128 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Vast.exe is not a PE file.')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (bytes.subarray(peOffset, peOffset + 4).toString('ascii') !== 'PE\0\0') throw new Error('Vast.exe has an invalid PE header.')
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Store Vast.exe is not x64.')
}

const unpackRoot = mkdtempSync(join(tmpdir(), 'vast-msix-verify-'))
try {
  const unpack = spawnSync(windowsSdkTool('MakeAppx.exe'), ['unpack', '/p', packagePath, '/d', unpackRoot, '/o'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (unpack.error || unpack.status !== 0) throw new Error(`MakeAppx could not unpack the MSIX: ${unpack.stderr || unpack.stdout || unpack.error?.message}`)

  const manifestPath = join(unpackRoot, 'AppxManifest.xml')
  const manifest = readFileSync(manifestPath, 'utf8')
  const expectedIdentity = identityFromEnv(process.env, development)
  const actual = {
    name: manifestAttribute(manifest, 'Identity', 'Name'),
    publisher: manifestAttribute(manifest, 'Identity', 'Publisher').replace(/&amp;/g, '&'),
    version: manifestAttribute(manifest, 'Identity', 'Version'),
    architecture: manifestAttribute(manifest, 'Identity', 'ProcessorArchitecture')
  }
  if (actual.name !== expectedIdentity.name) throw new Error(`MSIX identity name is ${actual.name}; expected ${expectedIdentity.name}.`)
  if (actual.publisher !== expectedIdentity.publisher) throw new Error('MSIX publisher does not match the selected Store identity.')
  if (actual.version !== msixVersionForSemver(packageVersion)) throw new Error(`MSIX version is ${actual.version}; expected ${msixVersionForSemver(packageVersion)}.`)
  if (actual.architecture !== 'x64') throw new Error('MSIX ProcessorArchitecture must be x64.')
  if (!new RegExp(`<Properties>[\\s\\S]*?<DisplayName>${STORE_DISPLAY_NAME}<\\/DisplayName>[\\s\\S]*?<\\/Properties>`).test(manifest)) {
    throw new Error(`MSIX package DisplayName must match the reserved Store name ${STORE_DISPLAY_NAME}.`)
  }
  if (manifestAttribute(manifest, 'uap:VisualElements', 'DisplayName') !== STORE_DISPLAY_NAME) {
    throw new Error(`MSIX application DisplayName must match the reserved Store name ${STORE_DISPLAY_NAME}.`)
  }
  if (!manifest.includes('uap10:RuntimeBehavior="packagedClassicApp"') || !manifest.includes('rescap:Capability Name="runFullTrust"')) {
    throw new Error('MSIX must declare a packaged classic app with only the required full-trust capability.')
  }
  for (const protocol of ['vast', 'http', 'https']) {
    if (!new RegExp(`<uap:Protocol\\s+Name="${protocol}"`).test(manifest)) throw new Error(`MSIX does not register the ${protocol} protocol.`)
  }
  if (!/<uap:Extension\s+Category="windows\.fileTypeAssociation">[\s\S]*?<uap:FileType>\.pdf<\/uap:FileType>/i.test(manifest)) {
    throw new Error('MSIX does not advertise Vast as a PDF file handler.')
  }

  const assetDimensions = {
    'StoreLogo.png': [50, 50],
    'Square44x44Logo.png': [44, 44],
    'Square150x150Logo.png': [150, 150],
    'Wide310x150Logo.png': [310, 150],
    'Square310x310Logo.png': [310, 310]
  }
  for (const [asset, expected] of Object.entries(assetDimensions)) {
    const dimensions = pngDimensions(join(unpackRoot, 'Assets', asset))
    if (dimensions.width !== expected[0] || dimensions.height !== expected[1]) throw new Error(`${asset} has invalid dimensions.`)
  }

  const vastExecutable = join(unpackRoot, 'Vast.exe')
  assertX64Pe(vastExecutable)
  const fuseCheck = spawnSync(process.execPath, [join(root, 'scripts', 'verify-electron-fuses.cjs'), vastExecutable], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (fuseCheck.error || fuseCheck.status !== 0) {
    throw new Error(`MSIX Electron fuse verification failed: ${fuseCheck.stderr || fuseCheck.stdout || fuseCheck.error?.message}`)
  }
  const files = allFiles(unpackRoot)
  const forbidden = files.map((path) => relative(unpackRoot, path).replace(/\\/g, '/')).filter((path) =>
    /(?:^|\/)(?:VastUpdater(?:[-.]|$)|app-update\.ya?ml$|latest(?:-beta)?\.ya?ml$|\.env(?:\.|$)|secrets?(?:\/|$))|\.(?:pfx|p12|pem|key|pk8|p8)$/i.test(path)
  )
  if (forbidden.length) throw new Error(`MSIX contains forbidden updater or secret material: ${forbidden.join(', ')}`)

  // Inventory every real PE by header, irrespective of filename. Partner
  // Center signs the MSIX as a package after certification; unsigned internal
  // runtime files are therefore evidence, not a separate publication blocker.
  const audit = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'scripts', 'verify-all-pe-signatures.ps1'),
    '-Root', unpackRoot,
    '-ReportOnly'
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  const reportLine = String(audit.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'))
  if (audit.error || audit.status !== 0 || !reportLine) {
    throw new Error(`MSIX recursive PE inventory produced no valid report: ${audit.stderr || audit.stdout || audit.error?.message || 'unknown error'}`)
  }
  let peInventory
  try {
    const report = JSON.parse(reportLine)
    if (!Number.isInteger(report.peCount) || report.peCount < 1) throw new Error('No PE files were inventoried.')
    peInventory = {
      status: 'InventoriedForStorePackageSigning',
      peCount: report.peCount,
      validAuthenticodeCount: report.validCount,
      unsignedOrOtherCount: report.failureCount
    }
  } catch (error) {
    throw new Error(`MSIX recursive PE inventory produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  const asar = require('@electron/asar')
  const appAsar = join(unpackRoot, 'resources', 'app.asar')
  const metadata = JSON.parse(asar.extractFile(appAsar, 'out\\release-build-metadata.json').toString('utf8'))
  if (metadata.version !== packageVersion) throw new Error('Packaged build metadata version does not match package.json.')
  if (metadata.distributionChannel !== 'microsoft-store') throw new Error('Packaged build metadata is not Microsoft Store scoped.')
  if (metadata.updateEnabled !== false) throw new Error('Direct auto-updates must be disabled in the Store build.')
  if (!development) {
    if (!/^[a-f0-9]{40}$/i.test(String(metadata.sourceCommit || ''))) throw new Error('Production Store package is missing its exact source commit.')
    if (!['beta', 'stable'].includes(metadata.releaseChannel) || metadata.privateBuild !== false) throw new Error('Production Store package is not public beta/stable scoped.')
    if (metadata.obfuscationEnabled !== true) throw new Error('Production Store package is not obfuscated.')
    if (metadata.signaturePolicy !== 'microsoft-store-submission') throw new Error('Production Store package has the wrong signing policy.')
    if (metadata.releaseRepo !== 'vstxx/vast-public') throw new Error('Production Store package has the wrong public release repository.')
    if (metadata.relay?.environment !== 'production' || metadata.relay?.endpoint !== 'https://relay.vastbrowser.com') {
      throw new Error('Production Store package does not use production Relay.')
    }
  }
  const mainBundle = asar.extractFile(appAsar, 'out\\main\\main.js').toString('utf8')
  if (!mainBundle.includes('https://extensions.vastbrowser.com')) throw new Error('Store package does not contain the production Extensions Hub origin.')
  if (!development) {
    if (!mainBundle.includes(metadata.relay.endpoint) || !mainBundle.includes(metadata.relay.keyId)) {
      throw new Error('Production Store main bundle does not contain its declared Relay endpoint and trust key.')
    }
    for (const stagingHostname of ['relay-staging.vastbrowser.com', 'extensions-staging.vastbrowser.com']) {
      if (mainBundle.includes(stagingHostname)) throw new Error(`Production Store package contains staging hostname ${stagingHostname}.`)
    }
  }

  let signatureStatus = 'NotRequiredForStoreSubmission'
  if (requireSignature) {
    const signature = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$s=Get-AuthenticodeSignature -LiteralPath $env:VAST_MSIX_VERIFY_PATH; [string]$s.Status'], {
      env: { ...process.env, VAST_MSIX_VERIFY_PATH: packagePath }, encoding: 'utf8', windowsHide: true
    })
    signatureStatus = String(signature.stdout).trim()
    if (signature.status !== 0 || signatureStatus !== 'Valid') throw new Error(`MSIX signature is ${signatureStatus || 'unavailable'}; expected Valid.`)
  }

  const bytes = readFileSync(packagePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifactBaseName = basename(packagePath, '.msix')
  const reportPath = join(dirname(packagePath), `${artifactBaseName}-verification.json`)
  const manifestSnapshotPath = join(dirname(packagePath), `${artifactBaseName}-AppxManifest.xml`)
  const checksumPath = join(dirname(packagePath), `${artifactBaseName}-SHA256SUMS.txt`)
  const report = {
    ok: true,
    packagePath,
    sha256,
    size: statSync(packagePath).size,
    identity: actual,
    semanticVersion: metadata.version,
    sourceCommit: metadata.sourceCommit,
    distributionChannel: metadata.distributionChannel,
    updaterEnabled: metadata.updateEnabled,
    relayEnvironment: metadata.relay?.environment,
    electronFuses: 'Verified',
    peInventory,
    signatureStatus,
    fileCount: files.length,
    reportPath,
    manifestSnapshotPath,
    checksumPath
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(manifestSnapshotPath, manifest, 'utf8')
  writeFileSync(checksumPath, `${sha256}  ${basename(packagePath)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  rmSync(unpackRoot, { recursive: true, force: true })
}
