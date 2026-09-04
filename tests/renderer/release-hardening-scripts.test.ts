import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const buildRelease = readFileSync(new URL('../../scripts/build-release.cjs', import.meta.url), 'utf8')
const releaseCheck = readFileSync(new URL('../../scripts/release-check.cjs', import.meta.url), 'utf8')
const releaseAudit = readFileSync(new URL('../../scripts/release-audit.cjs', import.meta.url), 'utf8')
const releaseVerifier = readFileSync(new URL('../../scripts/verify-release-package.cjs', import.meta.url), 'utf8')
const releaseMetadataWriter = readFileSync(new URL('../../scripts/write-release-build-metadata.cjs', import.meta.url), 'utf8')
const updaterSigner = readFileSync(new URL('../../scripts/sign-windows-updater.cjs', import.meta.url), 'utf8')
const localRelease = readFileSync(new URL('../../scripts/local-release-from-env.cjs', import.meta.url), 'utf8')
const releaseEnvExample = readFileSync(new URL('../../.env.release.example', import.meta.url), 'utf8')
const privateUnsignedBuilder = readFileSync(new URL('../../scripts/electron-builder-private-unsigned.cjs', import.meta.url), 'utf8')
const gitAttributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8')
const windowsCi = readFileSync(new URL('../../.github/workflows/windows-ci.yml', import.meta.url), 'utf8')
const appTestRunner = readFileSync(new URL('../../scripts/run-app-test.cjs', import.meta.url), 'utf8')
const isolatedE2eRunner = readFileSync(new URL('../../scripts/run-isolated-electron-e2e.cjs', import.meta.url), 'utf8')
const defaultBrowserE2e = readFileSync(new URL('../../scripts/register-default-browser-e2e.cjs', import.meta.url), 'utf8')
const extensionsE2e = readFileSync(new URL('../../scripts/extensions-e2e.cjs', import.meta.url), 'utf8')
const ffmpegCompliance = readFileSync(new URL('../../scripts/check-ffmpeg-release-compliance.cjs', import.meta.url), 'utf8')
const ffmpegRecipeVerifier = readFileSync(new URL('../../scripts/verify-vast-ffmpeg-recipe.cjs', import.meta.url), 'utf8')
const ffmpegPreparation = readFileSync(new URL('../../.github/actions/prepare-ffmpeg/action.yml', import.meta.url), 'utf8')
const prepareRelease = readFileSync(new URL('../../scripts/prepare-release.ps1', import.meta.url), 'utf8')
const hubWrangler = readFileSync(new URL('../../extensions-hub/wrangler.jsonc', import.meta.url), 'utf8')
const ffmpegBuilder = readFileSync(new URL('../../scripts/build-vast-ffmpeg.ps1', import.meta.url), 'utf8')
const afterSignAllPe = readFileSync(new URL('../../scripts/after-sign-all-pe.cjs', import.meta.url), 'utf8')
const publicReleaseWorkflow = readFileSync(new URL('../../.github/workflows/public-release.yml', import.meta.url), 'utf8')
const electronViteConfig = readFileSync(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8')
const tldtsRuntime = readFileSync(new URL('../../src/main/tldts-runtime.ts', import.meta.url), 'utf8')
const cleanUninstallE2e = readFileSync(new URL('../windows-clean-uninstall.test.ps1', import.meta.url), 'utf8')
const publicUpgradeE2e = readFileSync(new URL('../updater/vast-public-beta-upgrade.test.ps1', import.meta.url), 'utf8')
const windowsAuthenticode = readFileSync(new URL('../../scripts/windows-authenticode.cjs', import.meta.url), 'utf8')

test('automated app smoke builds cannot register Relay installations', () => {
  assert.match(windowsCi, /VAST_RELAY_ENABLED:\s*'0'/)
  assert.match(packageJson.scripts['test:app'], /run-app-test\.cjs/)
  assert.match(packageJson.scripts['test:split-view'], /run-app-test\.cjs --split-view-only/)
  assert.match(appTestRunner, /VAST_RELEASE_CHANNEL:\s*'dev'/)
  assert.match(appTestRunner, /VAST_PRIVATE_BUILD:\s*'1'/)
  assert.match(appTestRunner, /VAST_PUBLIC_UNSIGNED_RELEASE:\s*'0'/)
  assert.match(appTestRunner, /VAST_UPDATE_ENABLED:\s*'0'/)
  assert.match(appTestRunner, /VAST_OBFUSCATE:\s*'0'/)
  assert.match(appTestRunner, /VAST_RELAY_ENABLED:\s*'0'/)
  assert.match(appTestRunner, /VAST_RELAY_TEST_OFFLINE:\s*'1'/)
  assert.match(packageJson.scripts['test:extensions:e2e'], /run-isolated-electron-e2e\.cjs extensions-e2e\.cjs/)
  assert.match(packageJson.scripts['test:extensions:native-e2e'], /run-isolated-electron-e2e\.cjs native-extensions-e2e\.cjs/)
  assert.match(isolatedE2eRunner, /VAST_RELEASE_CHANNEL:\s*'dev'/)
  assert.match(isolatedE2eRunner, /VAST_PRIVATE_BUILD:\s*'1'/)
  assert.match(isolatedE2eRunner, /VAST_PUBLIC_UNSIGNED_RELEASE:\s*'0'/)
  assert.match(isolatedE2eRunner, /VAST_UPDATE_ENABLED:\s*'0'/)
  assert.match(isolatedE2eRunner, /VAST_OBFUSCATE:\s*'0'/)
  assert.match(isolatedE2eRunner, /VAST_RELAY_ENABLED:\s*'0'/)
  assert.match(isolatedE2eRunner, /VAST_INCLUDE_INTERNAL_TEST_HARNESS:\s*'1'/)
  assert.match(isolatedE2eRunner, /VAST_RELAY_TEST_OFFLINE:\s*'1'/)
})

test('extension E2E handles cold Chromium registration and scopes retained-tab UI assertions', () => {
  assert.match(extensionsE2e, /cold-registration-retry=1/)
  assert.match(extensionsE2e, /getBoundingClientRect\(\)/)
  assert.match(extensionsE2e, /visible extensions page before removal/)
  assert.match(extensionsE2e, /content script and chrome\.storage\.local/)
  assert.match(extensionsE2e, /maxRetries:\s*10, retryDelay:\s*100/)
  assert.match(extensionsE2e, /for \(let attempt = 0; attempt < 20/)
  assert.match(extensionsE2e, /\['EBUSY', 'EPERM'\]/)
})

test('the public release workflow fails immediately when any native quality command fails', () => {
  const publicUnsignedRelease = readFileSync(new URL('../../.github/workflows/public-unsigned-beta.yml', import.meta.url), 'utf8')
  assert.match(publicUnsignedRelease, /\$PSNativeCommandUseErrorActionPreference\s*=\s*\$true/)
})

test('package exposes the single-product hardened release pipeline', () => {
  assert.match(gitAttributes, /relay\/worker-configuration\.d\.ts text eol=lf/)
  assert.match(gitAttributes, /relay\/admin-configuration\.d\.ts text eol=lf/)
  assert.match(packageJson.scripts['release:check'], /release-check\.cjs/)
  assert.match(packageJson.scripts['release:audit'], /release-audit\.cjs/)
  assert.match(packageJson.scripts['release:windows'], /dist:upgrader/)
  assert.match(buildRelease, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(buildRelease, /electron-builder-private-unsigned\.cjs/)
  assert.match(privateUnsignedBuilder, /VAST_PRIVATE_BUILD/)
  assert.match(privateUnsignedBuilder, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(privateUnsignedBuilder, /forceCodeSigning:\s*false/)
  assert.match(privateUnsignedBuilder, /signExecutable:\s*false/)
  assert.match(localRelease, /delete env\.WIN_CSC_LINK/)
  assert.match(localRelease, /CSC_IDENTITY_AUTO_DISCOVERY = 'false'/)
  assert.match(buildRelease, /for \(const windowsTarget of \['portable', 'nsis'\]\)/)
  assert.match(buildRelease, /electronBuilderArgs\(windowsTarget\)/)
  assert.match(buildRelease, /write-release-build-metadata\.cjs/)
  assert.match(buildRelease, /sign-windows-updater\.cjs/)
  assert.match(buildRelease, /verify-release-package\.cjs/)
})

test('release verification covers packaged FFmpeg layout and removes tagged smoke profiles', () => {
  assert.match(ffmpegCompliance, /join\(runtime, 'bin', name\)/)
  assert.match(ffmpegCompliance, /join\(runtime, 'media', name\)/)
  assert.match(prepareRelease, /-Filter 'smoke-\*'/)
  assert.match(prepareRelease, /Refusing to remove path outside release root/)
  assert.match(prepareRelease, /System\.Security\.Cryptography\.SHA256/)
  assert.match(prepareRelease, /System\.Security\.Cryptography\.SHA512/)
  assert.doesNotMatch(prepareRelease, /Get-FileHash/)
  assert.match(ffmpegBuilder, /System\.Security\.Cryptography\.SHA256/)
  assert.doesNotMatch(ffmpegBuilder, /Get-FileHash/)
  assert.match(ffmpegPreparation, /verify-vast-ffmpeg-recipe\.cjs/)
  assert.match(ffmpegPreparation, /ffmpeg:release:check/)
  assert.match(ffmpegRecipeVerifier, /buildRecipeRevision/)
  assert.match(ffmpegRecipeVerifier, /package-corresponding-source\.sh/)
})

test('public upgrade integrity checks do not depend on the optional PowerShell hashing cmdlet', () => {
  assert.match(publicUpgradeE2e, /System\.Security\.Cryptography\.SHA256/)
  assert.match(publicUpgradeE2e, /Get-Sha256/)
  assert.doesNotMatch(publicUpgradeE2e, /Get-FileHash/)
})

test('public upgrade Authenticode gate imports the host security module instead of relying on inherited PSModulePath', () => {
  assert.match(publicUpgradeE2e, /Join-Path \$PSHOME 'Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'/)
  assert.match(publicUpgradeE2e, /Test-Path -LiteralPath \$securityModule -PathType Leaf/)
  assert.match(publicUpgradeE2e, /Import-Module -Name \$securityModule -Force -ErrorAction Stop/)
  assert.match(publicUpgradeE2e, /Get-AuthenticodeSignature is unavailable after loading Microsoft\.PowerShell\.Security\./)
  assert.match(publicUpgradeE2e, /Get-AuthenticodeSignature -LiteralPath/)
})

test('unsigned publication routes plain git through GitHub CLI credentials and preserves a resumable release candidate', () => {
  const publicUnsignedRelease = readFileSync(new URL('../../.github/workflows/public-unsigned-beta.yml', import.meta.url), 'utf8')
  assert.match(publicUnsignedRelease, /gh auth setup-git --hostname github\.com/)
  assert.match(publicUnsignedRelease, /repos\/vstxx\/vast-public --jq \.permissions\.push/)
  assert.match(publicUnsignedRelease, /must grant push \(write\) access to vstxx\/vast-public/)
  assert.doesNotMatch(publicUnsignedRelease, /https:\/\/[^'"\s]*@/)
  assert.ok(
    publicUnsignedRelease.indexOf('-release-candidate') <
      publicUnsignedRelease.indexOf('Publish matching public source snapshot and immutable tag'),
    'the release-candidate artifact must be preserved before any publishing step runs'
  )
  assert.match(publicUnsignedRelease, /if-no-files-found: error/)
  for (const candidatePath of ['release/Installer/', 'release/Updater/', 'release/Downloads/', 'release/Checksums/', 'release/Docs/', 'release/Source/', 'out/release-build-metadata.json']) {
    assert.ok(publicUnsignedRelease.includes(candidatePath), `release candidate must include ${candidatePath}`)
  }
})

test('signed releases fail fast and sign every detected PE without weakening the acknowledged unsigned route', () => {
  assert.match(packageJson.build.afterSign, /after-sign-all-pe\.cjs/)
  assert.match(afterSignAllPe, /verify-all-pe-signatures\.ps1/)
  assert.match(afterSignAllPe, /context\.packager\.signIf/)
  assert.match(afterSignAllPe, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(afterSignAllPe, /VAST_PUBLIC_UNSIGNED_RELEASE/)
  assert.match(afterSignAllPe, /I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK/)
  assert.match(publicReleaseWorkflow, /Fail fast when signed-release credentials are unavailable/)
  assert.ok(
    publicReleaseWorkflow.indexOf('Fail fast when signed-release credentials are unavailable') <
      publicReleaseWorkflow.indexOf('Restore or build pinned Vast FFmpeg with corresponding source')
  )
})

test('the Windows gate installs, launches, registers and cleanly uninstalls signed or explicitly unsigned Vast', () => {
  assert.match(publicReleaseWorkflow, /windows-clean-uninstall\.test\.ps1/)
  assert.match(cleanUninstallE2e, /explicitUnsignedRelease/)
  assert.match(cleanUninstallE2e, /VAST_UNSIGNED_RELEASE_ACK/)
  assert.match(cleanUninstallE2e, /I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK/)
  assert.match(cleanUninstallE2e, /expectedSignatureStatus/)
  assert.match(cleanUninstallE2e, /-ReportOnly/)
  assert.match(cleanUninstallE2e, /register-default-browser-e2e\.cjs/)
  assert.match(defaultBrowserE2e, /registration\?\.ok !== true/)
  assert.match(defaultBrowserE2e, /registration\?\.status/)
  assert.match(cleanUninstallE2e, /verify-all-pe-signatures\.ps1/)
  assert.match(cleanUninstallE2e, /RegisteredApplications must advertise Vast capabilities/)
  assert.match(cleanUninstallE2e, /registryKey\.GetValueNames\(\)/)
  assert.doesNotMatch(cleanUninstallE2e, /reg\.exe query \$Key \/v/)
  assert.match(cleanUninstallE2e, /uninstall must remove every installer-owned runtime file/)
  assert.match(cleanUninstallE2e, /UserChoice/)
  assert.match(cleanUninstallE2e, /profilePreservedByUninstaller = \$true/)
  assert.match(cleanUninstallE2e, /fallbackUninstaller/)
})

test('the complete public-suffix runtime stays out of production node_modules and is integrity checked', () => {
  assert.equal(packageJson.dependencies.tldts, undefined)
  assert.equal(packageJson.devDependencies.tldts, '7.4.11')
  assert.match(electronViteConfig, /find: \/\^tldts\$\//)
  assert.ok(packageJson.build.extraResources.some((entry: { from?: string; to?: string }) =>
    entry.from === 'node_modules/tldts/dist/index.cjs.min.js' && entry.to === 'runtime/tldts.cjs'
  ))
  assert.match(tldtsRuntime, /createHash\('sha256'\)/)
  assert.match(tldtsRuntime, /7ae8df69275a9dc3d2258587a6ce375dc4de58c632151c40dfff55d71c899c3b/)
})

test('public release check requires signing, updater, obfuscation, and repo without licensing config', () => {
  assert.match(releaseCheck, /WIN_CSC_LINK/)
  assert.match(releaseCheck, /VAST_UPDATE_ENABLED/)
  assert.match(releaseCheck, /VAST_OBFUSCATE/)
  assert.match(releaseCheck, /vstxx\/vast-public/)
  assert.doesNotMatch(releaseCheck, /VAST_LICENSE|VAST_PRO_BUILD_ENTITLEMENT/)
})

test('release audit retains Electron, Authenticode, updater, and package checks', () => {
  for (const marker of [
    'contextIsolation',
    'updater install gated by ready state',
    'storage restore validates payloads',
    'strict app chrome CSP exists',
    'public signing fails closed',
    'standalone updater signing exists',
    'release verifier requires Authenticode and obfuscation evidence'
  ]) {
    assert.match(releaseAudit, new RegExp(marker))
  }
  assert.match(releaseVerifier, /@electron\/asar/)
  assert.match(releaseVerifier, /inspectUnsignedPe/)
  assert.match(releaseAudit, /windows-authenticode\.cjs/)
  assert.match(releaseAudit, /inspectTrustedAuthenticode/)
  assert.match(releaseAudit, /inspectUnsignedPe/)
  assert.match(windowsAuthenticode, /Get-AuthenticodeSignature/)
  assert.match(windowsAuthenticode, /certificateTablePresent/)
  assert.match(windowsAuthenticode, /name\.toLowerCase\(\) === 'psmodulepath'/)
  assert.match(windowsAuthenticode, /String\(result\.stderr/)
  assert.match(updaterSigner, /RFC 3161 timestamp/)
  assert.match(releaseMetadataWriter, /release-build-metadata\.json/)
})

test('local release environment documents only release hardening and signing inputs', () => {
  assert.match(localRelease, /\.env\.release\.local/)
  assert.match(releaseEnvExample, /VAST_RELEASE_REPO=vstxx\/vast-public/)
  assert.match(releaseEnvExample, /VAST_UPDATE_ENABLED=1/)
  assert.match(releaseEnvExample, /VAST_OBFUSCATE=1/)
  assert.match(releaseEnvExample, /VAST_PREVIOUS_VERSION=0\.2\.5/)
  assert.match(releaseEnvExample, /VAST_PUBLIC_UNSIGNED_RELEASE=1/)
  assert.match(releaseEnvExample, /I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK/)
  assert.match(releaseEnvExample, /VAST_RELAY_ENABLED=1/)
  assert.match(releaseEnvExample, /VAST_RELAY_ENVIRONMENT=production/)
  assert.match(releaseEnvExample, /WIN_CSC_LINK/)
  assert.doesNotMatch(releaseEnvExample, /VAST_LICENSE|VAST_PRO_BUILD_ENTITLEMENT|supabase/i)
})

test('Hub staging is isolated from production resources and scheduled work', () => {
  assert.match(hubWrangler, /"name": "vast-extensions-hub-staging"/)
  assert.match(hubWrangler, /"pattern": "extensions-staging\.vastbrowser\.com"/)
  assert.match(hubWrangler, /"database_name": "vast-extensions-hub-staging"/)
  assert.match(hubWrangler, /"bucket_name": "vast-extensions-packages-staging"/)
  assert.match(hubWrangler, /"ENVIRONMENT": "staging"/)
  assert.match(hubWrangler, /"triggers": \{ "crons": \[\] \}/)
})
