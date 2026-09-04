const assert = require('node:assert/strict')
const test = require('node:test')
const {
  identityFromEnv,
  manifestXml,
  msixVersionForSemver,
  STORE_DISPLAY_NAME
} = require('../../scripts/store-msix-config.cjs')
const { recencyReport } = require('../../scripts/check-store-browser-recency.cjs')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')
const storeBuilderConfig = readFileSync(join(root, 'scripts', 'electron-builder-store.cjs'), 'utf8')
const storeReleaseCheck = readFileSync(join(root, 'scripts', 'release-store-check.cjs'), 'utf8')
const storeVerifier = readFileSync(join(root, 'scripts', 'verify-store-msix.cjs'), 'utf8')
const peVerifier = readFileSync(join(root, 'scripts', 'verify-all-pe-signatures.ps1'), 'utf8')
const storeUpgradeE2e = readFileSync(join(root, 'tests', 'store', 'store-msix-upgrade.test.ps1'), 'utf8')
const windowsCi = readFileSync(join(root, '.github', 'workflows', 'windows-ci.yml'), 'utf8')
const packagedLaunchHealth = readFileSync(join(root, 'tests', 'store', 'packaged-launch-health.test.ps1'), 'utf8')
const wackRunner = readFileSync(join(root, 'scripts', 'run-windows-app-certification.ps1'), 'utf8')

test('semantic versions map monotonically to Store-compatible four-part versions', () => {
  assert.equal(msixVersionForSemver('0.2.7'), '1.2.8.0')
  assert.equal(msixVersionForSemver('0.2.8'), '1.2.9.0')
  assert.equal(msixVersionForSemver('1.0.0'), '2.0.1.0')
  assert.throws(() => msixVersionForSemver('0.2.7-beta.1'), /stable x\.y\.z/)
  assert.throws(() => msixVersionForSemver('1.0.65535'), /cannot be represented/)
})

test('production Store identity fails closed and development identity is explicit', () => {
  assert.throws(() => identityFromEnv({}, false), /VAST_MSIX_IDENTITY_NAME/)
  assert.deepEqual(identityFromEnv({}, true), {
    name: 'VastBrowser.Development',
    publisher: 'CN=Vast Browser Development',
    publisherDisplayName: 'Vast Browser Development'
  })
})

test('manifest declares one x64 packaged classic app and only required capabilities', () => {
  const source = manifestXml(identityFromEnv({}, true), '0.2.7')
  assert.equal(STORE_DISPLAY_NAME, 'Vast Browser')
  assert.match(source, /<Properties>[\s\S]*?<DisplayName>Vast Browser<\/DisplayName>/)
  assert.match(source, /<uap:VisualElements\s+DisplayName="Vast Browser"/)
  assert.doesNotMatch(source, /<Properties>[\s\S]*?<DisplayName>Vast<\/DisplayName>/)
  assert.match(source, /Version="1\.2\.8\.0" ProcessorArchitecture="x64"/)
  assert.match(source, /uap10:RuntimeBehavior="packagedClassicApp"/)
  assert.match(source, /rescap:Capability Name="runFullTrust"/)
  assert.match(source, /Capability Name="internetClient"/)
  assert.doesNotMatch(source, /broadFileSystemAccess|unvirtualizedResources|runAsAdmin/)
  for (const protocol of ['vast', 'http', 'https']) assert.match(source, new RegExp(`Protocol Name="${protocol}"`))
  assert.match(source, /Category="windows\.fileTypeAssociation"/)
  assert.match(source, /<uap:FileType>\.pdf<\/uap:FileType>/)
})

test('browser recency permits at most two Chromium majors and rejects stale policy evidence', () => {
  const reviewed = Date.parse('2026-08-30T00:00:00Z')
  assert.equal(recencyReport('152.0.0.0', '154.0.0.0', reviewed).ok, true)
  assert.equal(recencyReport('151.0.0.0', '154.0.0.0', reviewed).ok, false)
  assert.equal(recencyReport('152.0.0.0', '152.0.0.0', Date.parse('2027-01-01T00:00:00Z')).ok, false)
})

test('Store package relies on Partner Center signing and keeps a recursive PE inventory', () => {
  assert.match(storeBuilderConfig, /forceCodeSigning: false/)
  assert.match(storeBuilderConfig, /afterSign: undefined/)
  assert.match(storeBuilderConfig, /signExecutable: false/)
  assert.doesNotMatch(storeReleaseCheck, /WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD/)
  assert.match(storeVerifier, /verify-all-pe-signatures\.ps1/)
  assert.match(storeVerifier, /'-ReportOnly'/)
  assert.doesNotMatch(storeVerifier, /report\.validCount !== report\.peCount/)
  assert.match(storeVerifier, /mainBundle\.includes\(metadata\.relay\.endpoint\)/)
  assert.match(storeVerifier, /mainBundle\.includes\(metadata\.relay\.keyId\)/)
  assert.match(storeVerifier, /relay-staging\.vastbrowser\.com/)
  assert.match(storeVerifier, /reserved Store name/)
  assert.match(peVerifier, /Join-Path \$PSHOME 'Modules\\Microsoft\.PowerShell\.Security/)
  assert.match(peVerifier, /Import-Module -Name \$securityModule -Force -ErrorAction Stop/)
  assert.match(storeReleaseCheck, /dirtyWorktree\.slice\(0, 20\)/)
})

test('Store upgrade E2E uses isolated locally signed test identities and full package servicing', () => {
  assert.match(storeUpgradeE2e, /\$testPublisher = 'CN=Vast Browser Development'/)
  assert.match(storeUpgradeE2e, /\$ExpectedVersion = '1\.2\.8\.0'/)
  assert.equal((storeUpgradeE2e.match(/1\.2\.7\.0/g) || []).length, 3)
  assert.doesNotMatch(storeUpgradeE2e, /1\.2\.6\.0/)
  assert.match(storeUpgradeE2e, /Add-AppxPackage -Path \$lowerPackage/)
  assert.match(storeUpgradeE2e, /Add-AppxPackage -Path \$currentPackage/)
  assert.doesNotMatch(storeUpgradeE2e, /Add-AppxPackage[^\r\n]*-AllowUnsigned/)
  assert.match(storeUpgradeE2e, /New-SelfSignedCertificate/)
  assert.match(storeUpgradeE2e, /Import-Certificate/)
  assert.match(storeUpgradeE2e, /SignTool\.exe/)
  assert.match(storeUpgradeE2e, /WindowsBuiltInRole\]::Administrator/)
  assert.match(storeUpgradeE2e, /Cert:\\LocalMachine\\TrustedPeople/)
  assert.match(storeUpgradeE2e, /Remove-Item -LiteralPath \$certificatePath -Force/)
  assert.match(storeUpgradeE2e, /LocalCache\\Roaming\\Vast/)
  assert.match(storeUpgradeE2e, /packageDataRemovedOnUninstall = \$true/)
  assert.match(storeUpgradeE2e, /MSIX uninstall must leave no Vast development package data directory/)
  assert.match(storeUpgradeE2e, /\$before = \$probeFiles\.GetEnumerator\(\)/)
  assert.doesNotMatch(storeUpgradeE2e, /\$before = Get-ChildItem -LiteralPath \$profileRoot/)
  assert.match(storeUpgradeE2e, /function Stop-PackagedVast/)
  assert.match(storeUpgradeE2e, /function Assert-PackagedVastLaunchHealthy/)
  assert.match(storeUpgradeE2e, /Get-VastApplicationErrors/)
  assert.match(storeUpgradeE2e, /LaunchHealthSeconds/)
  assert.doesNotMatch(storeUpgradeE2e, /Start-Sleep -Seconds 2/)
  assert.match(storeUpgradeE2e, /function Wait-PackagedVastRemoval/)
  assert.match(storeUpgradeE2e, /Wait-PackagedVastRemoval 'VastBrowser\.Development' \$installLocation \$packageDataRoot/)
  assert.doesNotMatch(storeUpgradeE2e, /Remove-Item -LiteralPath \$installLocation/)
  assert.match(storeUpgradeE2e, /\$processes \| Stop-Process -Force/)
  assert.match(storeUpgradeE2e, /-ForceUpdateFromAnyVersion -ForceApplicationShutdown/)
  assert.match(storeUpgradeE2e, /\$unpackOutput = @\(& \$makeAppx unpack/)
  assert.match(storeUpgradeE2e, /\$packCurrentOutput = @\(& \$makeAppx pack[^\r\n]*\/nc/)
  assert.match(storeUpgradeE2e, /\$packOutput = @\(& \$makeAppx pack[^\r\n]*\/nc/)
  assert.doesNotMatch(storeUpgradeE2e, /& \$makeAppx (?:unpack|pack)[^\r\n]*\| Out-Host/)
})

test('Windows packaged launch gates exercise the production GPU path', () => {
  assert.doesNotMatch(windowsCi, /--disable-gpu/)
  assert.match(windowsCi, /packaged-launch-health\.test\.ps1/)
  assert.doesNotMatch(packagedLaunchHealth, /ArgumentList[^\r\n]*--disable-gpu/)
  assert.match(packagedLaunchHealth, /WaitForExit\(\$MinimumUptimeSeconds \* 1000\)/)
  assert.match(packagedLaunchHealth, /production-GPU health window/)
  assert.match(packagedLaunchHealth, /Get-VastApplicationErrors/)
})

test('WACK gate requires a complete overall PASS instead of accepting a passing child test', () => {
  assert.match(wackRunner, /\$reportDocument = \[xml\] \$report/)
  assert.match(wackRunner, /GetAttribute\('OVERALL_RESULT'\)/)
  assert.match(wackRunner, /\$overallResult -eq 'PASS'/)
  assert.match(wackRunner, /GetAttribute\('PARTIAL_RUN'\)/)
  assert.match(wackRunner, /\$partialRun -eq 'FALSE'/)
  assert.match(wackRunner, /\$requiredFailedTests\.Count -eq 0/)
  assert.doesNotMatch(wackRunner, /<RESULT>\\s\*PASS/)
})
