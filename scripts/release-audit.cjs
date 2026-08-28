const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

const checks = []

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail })
}

const pkg = JSON.parse(read('package.json'))
const windowSource = read('src/main/window.ts')
const updaterSource = read('src/main/updater.ts')
const storageSource = read('src/main/storage.ts')
const ipcSource = read('src/main/ipc.ts')
const ipcSecuritySource = read('src/main/ipc-security.ts')
const mainSource = read('src/main/main.ts')
const sessionsSource = read('src/main/sessions.ts')
const cspSource = read('src/main/csp.ts')
const preloadSource = read('src/preload/index.ts')
const typesSource = read('src/shared/types.ts')
const buildMetadataSource = read('src/shared/build-metadata.ts')
const releasePackageVerifierSource = read('scripts/verify-release-package.cjs')
const publishedReleaseVerifierSource = read('scripts/verify-published-release.cjs')
const publicReleaseWorkflowSource = read('.github/workflows/public-release.yml')
const publicUnsignedBetaWorkflowSource = read('.github/workflows/public-unsigned-beta.yml')
const windowsCiSource = read('.github/workflows/windows-ci.yml')
const hubStagingEdgeWorkflowSource = read('.github/workflows/hub-staging-edge.yml')
const hubStagingEdgeVerifierSource = read('scripts/verify-hub-staging-edge.mjs')
const releaseReadinessSource = read('docs/RELEASE_0.2.5_READINESS.md')
const extensionMatchPatternSource = read('src/shared/extension-match-pattern.ts')
const vextFormatSource = read('src/shared/vext-format.ts')
const desktopExtensionManifestSource = read('src/main/extensions/extension-manifest.ts')
const hubValidationSource = read('extensions-hub/src/validation.ts')
const hubIndexSource = read('extensions-hub/src/index.ts')
const hubSecuritySource = read('extensions-hub/src/security.ts')
const hubLegalSource = read('extensions-hub/src/legal.ts')
const hubMigrationSource = read('extensions-hub/migrations/0003_publisher_terms_privacy_reports.sql')
const hubWranglerSource = read('extensions-hub/wrangler.jsonc')
const relayStagingVerifierSource = read('relay/scripts/verify-staging.mjs')
const avidaeRuntimeSource = read('src/main/avidae-runtime.ts')
const avidaeRuntimeBuilderSource = read('scripts/prepare-avidae-runtime.cjs')
const ffmpegLock = JSON.parse(read('third_party/ffmpeg/ffmpeg-build.lock.json'))
const ffmpegBuilderSource = read('scripts/build-vast-ffmpeg.ps1')
const ffmpegComplianceSource = read('scripts/check-ffmpeg-release-compliance.cjs')
const pythonRuntimeLicenseCollectorSource = read('scripts/copy-python-runtime-licenses.py')
const releaseMetadataWriterSource = read('scripts/write-release-build-metadata.cjs')
const updaterSignerSource = read('scripts/sign-windows-updater.cjs')
const windowsIconHookSource = read('scripts/apply-windows-icon.cjs')
const localReleaseSource = read('scripts/local-release-from-env.cjs')
const afterPackHardeningSource = read('scripts/after-pack-hardening.cjs')
const fuseHookSource = read('scripts/electron-fuses.cjs')
const releaseBuilderSource = read('scripts/build-release.cjs')
const distributionBudgetSource = read('scripts/check-distribution-size-budget.cjs')
const noticesSource = read('src/main/notices.ts')
const noticesFeedSource = read('src/main/notices-feed.ts')
const noticesTrustSource = read('src/shared/notices-trust.ts')
const passwordSessionSource = read('src/main/password-vault-session.ts')
const passwordSessionPolicySource = read('src/main/password-vault-session-policy.ts')
const runtimeFeaturePolicySource = read('src/main/runtime-feature-policy.ts')
const sensitiveIpcPolicy = JSON.parse(read('src/shared/sensitive-ipc-policy.json'))
const trustDomains = JSON.parse(read('src/shared/trust-domains.json'))
const { REQUIRED_ELECTRON_FUSES } = require('./electron-fuses.cjs')

const expectedSensitiveIpcFeatures = {
  'vast:avidae:status': 'avidae',
  'vast:avidae:start': 'avidae',
  'vast:avidae:stop': 'avidae',
  'vast:avidae:install-dependencies': 'avidae',
  'vast:network:get-devices': 'network-devices',
  'vast:network:scan': 'network-devices',
  'vast:network:update-device': 'network-devices',
  'vast:network:forget-device': 'network-devices',
  'vast:network:clear-cache': 'network-devices',
  'vast:network:export-inventory': 'network-devices',
  'vast:passwords:session-status': 'password-manager',
  'vast:passwords:unlock-session': 'password-manager',
  'vast:passwords:lock-session': 'password-manager',
  'vast:passwords:list': 'password-manager',
  'vast:passwords:create': 'password-manager',
  'vast:passwords:update': 'password-manager',
  'vast:passwords:remove': 'password-manager',
  'vast:passwords:copy-username': 'password-manager',
  'vast:passwords:copy-password': 'password-manager',
  'vast:passwords:autofill': 'password-manager',
  'vast:passwords:autofill-suggestions': 'password-manager',
  'vast:passwords:fill-by-id': 'password-manager',
  'vast:passwords:save-captured': 'password-manager',
  'vast:passwords:capture-status': 'password-manager',
  'vast:passwords:capture-login': 'password-manager',
  'vast:passwords:allow-save-prompts': 'password-manager',
  'vast:passwords:import-csv': 'password-manager',
  'vast:passwords:export-csv': 'password-manager',
  'vast:passwords:audit': 'password-manager',
  'vast:app:diagnostics': 'advanced-diagnostics',
  'vast:app:process-metrics': 'advanced-diagnostics'
}

function stableRecord(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))
}

check('electron contextIsolation enabled', /contextIsolation:\s*true/.test(windowSource), 'BrowserWindow must isolate renderer context')
check('electron sandbox enabled', /sandbox:\s*true/.test(windowSource), 'BrowserWindow must enable sandbox')
check('electron nodeIntegration disabled', /nodeIntegration:\s*false/.test(windowSource), 'BrowserWindow must not expose Node to renderer')
check('electron webSecurity enabled', /webSecurity:\s*true/.test(windowSource), 'BrowserWindow must keep webSecurity enabled')
check('background throttling default safe', !/backgroundThrottling:\s*false/.test(windowSource), 'Background throttling should not be disabled unconditionally')

check(
  'windows signing enabled',
  pkg.build?.win?.signAndEditExecutable === true && pkg.build?.win?.signExecutable === true,
  'Windows executable editing and signing must be enabled for releases'
)
check('security-patched release dependencies pinned', pkg.dependencies?.['electron-updater'] === '6.8.9' && pkg.devDependencies?.['pdfjs-dist'] === '6.2.108' && pkg.devDependencies?.['electron-builder'] === '26.15.3' && pkg.devDependencies?.postcss === '8.5.25' && pkg.devDependencies?.['@electron/fuses'] === '2.1.2', 'Updater, bundled PDF renderer, packager, CSS tooling, and fuse tooling must remain on the audited patched versions')
check('Electron 43 runtime is pinned and executable-verified', pkg.devDependencies?.electron === '43.4.1' && String(pkg.scripts?.['test:electron-version'] ?? '').includes('verify-electron-version.cjs') && read('scripts/verify-electron-version.cjs').includes('150.0.7871.224') && read('scripts/verify-electron-version.cjs').includes('24.18.1') && read('scripts/verify-electron-version.cjs').includes('15.0.245.28'), 'Electron must remain exactly 43.4.1 and the installed executable must report the audited Chromium, Node, and V8 stack')
check('renderer-only packages are not duplicated in app.asar', ['clsx', 'lucide-react', 'pdfjs-dist', 'react', 'react-dom', 'zustand'].every((name) => !pkg.dependencies?.[name] && !!pkg.devDependencies?.[name]), 'Renderer-only packages must be bundled by Vite instead of duplicated as production node_modules')
check('npm audit is a CI gate for client and Relay', String(pkg.scripts?.['audit:ci'] ?? '').includes('npm audit --audit-level=high') && String(pkg.scripts?.['audit:ci'] ?? '').includes('npm audit --prefix relay --audit-level=high') && read('.github/workflows/windows-ci.yml').includes('npm run audit:ci'), 'CI must reject HIGH or CRITICAL npm advisories in both lockfiles')
check('public signing fails closed', pkg.build?.forceCodeSigning === true && /electron-builder-private-unsigned\.cjs/.test(read('scripts/build-release.cjs')), 'Signed public builds must require signing while explicit private QA builds may opt out')
check('hardening hook runs before signing', pkg.build?.afterPack === 'scripts/after-pack-hardening.cjs' && afterPackHardeningSource.indexOf('applyWindowsIcon(context)') < afterPackHardeningSource.indexOf('applyElectronFuses(context)') && /packager\?\.getIconPath/.test(windowsIconHookSource), 'Icon resources and Electron fuses must be applied in afterPack before signing')
check('required Electron fuses are fail-closed', REQUIRED_ELECTRON_FUSES.RunAsNode === false && REQUIRED_ELECTRON_FUSES.EnableNodeOptionsEnvironmentVariable === false && REQUIRED_ELECTRON_FUSES.EnableNodeCliInspectArguments === false && REQUIRED_ELECTRON_FUSES.EnableEmbeddedAsarIntegrityValidation === true && REQUIRED_ELECTRON_FUSES.OnlyLoadAppFromAsar === true && fuseHookSource.includes('strictlyRequireAllFuses: true') && fuseHookSource.includes('assertFuseState'), 'Packaged Electron must disable Node/inspect escape hatches and verify ASAR-only integrity fuses')
check('real Electron fuse integration check exists', String(pkg.scripts?.['test:fuses:integration'] ?? '').includes('test-electron-fuses-integration.cjs') && existsSync(join(root, 'scripts/test-electron-fuses-integration.cjs')) && existsSync(join(root, 'scripts/verify-electron-fuses.cjs')), 'The fuse profile must be executable against and readable from real Electron binaries')
check('github publish target configured', pkg.build?.publish?.owner === 'vstxx' && pkg.build?.publish?.repo === 'vast-public', 'GitHub publish target must be vstxx/vast-public')
check('dist uses obfuscation pipeline', String(pkg.scripts?.dist ?? '').includes('build:obfuscated'), 'dist script should run build:obfuscated')
check('public release command builds one updater package', String(pkg.scripts?.['dist:public'] ?? '').includes('dist:upgrader') && String(pkg.scripts?.['release:stable'] ?? '').includes('dist:upgrader') && String(pkg.scripts?.['release:windows'] ?? '').includes('dist:upgrader'), 'Public release scripts must route to the single installer plus updater package')
check('release distribution size budget is enforced', String(pkg.scripts?.['distribution:size-budget'] ?? '').includes('check-distribution-size-budget.cjs') && releaseBuilderSource.includes("'distribution:size-budget'") && distributionBudgetSource.includes('playwrightHeadlessShell') && distributionBudgetSource.includes('ffmpegAndFfprobe'), 'Every full release must fail clearly when installer, portable, updater, browser, media, PyInstaller, or app payload sizes regress')
check('NSIS leaves the canonical updater-ready runtime', releaseBuilderSource.includes("['portable', 'nsis']") && releasePackageVerifierSource.includes("'app-update.yml'") && releasePackageVerifierSource.includes("'provider: github'"), 'NSIS must package last and the final full-update payload must contain the approved electron-updater configuration')
check('release package verifier exists', /VastUpdater-\$\{version\}\.exe/.test(releasePackageVerifierSource) && /Vast-Setup-\$\{version\}\.exe/.test(releasePackageVerifierSource), 'Release package verifier must require expected EXEs')
check('full update ZIP is structurally verified', releasePackageVerifierSource.includes('verify-update-archive.ps1') && read('scripts/verify-update-archive.ps1').includes('app-update.yml') && read('scripts/verify-update-archive.ps1').includes('path traversal'), 'The full-update fallback must reject traversal, duplicate entries, missing runtime files, and nested distribution artifacts')
check('standalone updater signing exists', /signtool/.test(updaterSignerSource) && /VastUpdater-\$\{pkg\.version\}\.exe/.test(updaterSignerSource) && /RFC 3161 timestamp/.test(updaterSignerSource), 'Public stable updater must be signed and timestamped after it is built')
check('local release env guard exists', String(pkg.scripts?.['release:local'] ?? '').includes('local-release-from-env.cjs') && /VAST_RELEASE_REPO/.test(localReleaseSource) && /VAST_UPDATE_ENABLED/.test(localReleaseSource) && /VAST_OBFUSCATE/.test(localReleaseSource), 'Local releases must load .env.release.local and require release hardening metadata')
check('release metadata writer exists', /release-build-metadata\.json/.test(releaseMetadataWriterSource) && /releaseRepo/.test(releaseMetadataWriterSource) && /obfuscationEnabled/.test(releaseMetadataWriterSource) && /noticesFeedOrigin/.test(releaseMetadataWriterSource), 'Release builds must write updater, Notices trust, and hardening metadata')
check('release verifier reads packaged metadata from asar', /@electron\/asar/.test(releasePackageVerifierSource) && /release-build-metadata\.json/.test(releasePackageVerifierSource) && /obfuscationEnabled/.test(releasePackageVerifierSource) && /releaseRepo/.test(releasePackageVerifierSource), 'Release verifier must inspect packaged app.asar metadata')
check('release verifier requires Authenticode and obfuscation evidence', /Get-AuthenticodeSignature/.test(releasePackageVerifierSource) && /missing an RFC 3161 timestamp/.test(releasePackageVerifierSource) && /obfuscation-report\.json/.test(releasePackageVerifierSource), 'Public stable release verification must require valid timestamped signatures and packaged obfuscation evidence')
check('published artifacts are downloaded and reverified', /VAST_PRODUCTION_RELEASE_BASE_URL/.test(publishedReleaseVerifierSource) && /Get-AuthenticodeSignature/.test(publishedReleaseVerifierSource) && /Production asset differs from the locally verified artifact/.test(publishedReleaseVerifierSource) && String(pkg.scripts?.['release:verify:published'] ?? '').includes('verify-published-release.cjs'), 'Final release gate must download the production assets, match local hashes, and reverify signatures and timestamps')
check('draft verifier resolves unpublished releases through the release list', /releases\?per_page=100/.test(publishedReleaseVerifierSource) && /candidate\?\.draft === true/.test(publishedReleaseVerifierSource) && /candidate\?\.tag_name === `v\$\{version\}`/.test(publishedReleaseVerifierSource), 'GitHub draft releases must be found before their tag exists')
check('public beta uses the full signing gate', publicReleaseWorkflowSource.includes('Public signed release') && publicReleaseWorkflowSource.includes('options: [beta, stable]') && publicReleaseWorkflowSource.includes('WIN_CSC_LINK') && publicReleaseWorkflowSource.includes('release:verify:published') && /\['beta', 'stable'\]/.test(updaterSignerSource), 'Public beta and stable must share the signed, timestamped distribution pipeline')
check(
  'public unsigned beta is explicit and isolated from signed releases',
  publicUnsignedBetaWorkflowSource.includes('I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK') &&
    publicUnsignedBetaWorkflowSource.includes('PUBLIC-UNSIGNED-BETA.md') &&
    publicUnsignedBetaWorkflowSource.includes('--prerelease') &&
    publicUnsignedBetaWorkflowSource.includes('release:verify:published') &&
    read('scripts/electron-builder-public-unsigned-beta.cjs').includes('VAST_PUBLIC_UNSIGNED_BETA') &&
    releasePackageVerifierSource.includes("signature.Status !== 'NotSigned'") &&
    publishedReleaseVerifierSource.includes("signature.Status !== 'NotSigned'"),
  'Unsigned public distribution must remain beta-only, explicitly acknowledged, visibly marked, hash/provenance verified, and separate from the signed gate'
)
check('real public 0.1.5 upgrade gate exists', existsSync(join(root, 'tests/updater/vast-0.1.5-to-0.2.5-upgrade.test.ps1')) && publicUnsignedBetaWorkflowSource.includes('test:upgrade:0.1.5') && read('tests/updater/vast-0.1.5-to-0.2.5-upgrade.test.ps1').includes('a82c0a9cfea5564894db3b9bb3eedf9ce976d811bcfeb7c8680c9f6f6408b06a') && read('tests/updater/vast-0.1.5-to-0.2.5-upgrade.test.ps1').includes('Relay install identity must survive the upgrade'), 'Public distribution must verify the immutable unsigned 0.1.5 installer to local 0.2.5 upgrade and preserve user data')
check('release verifier reads final Electron fuse wire', releasePackageVerifierSource.includes('verify-electron-fuses.cjs') && releasePackageVerifierSource.includes('electronFuses'), 'Final signed runtime verification must re-read the Electron fuse wire')
const protocolSchemes = (pkg.build?.protocols ?? []).flatMap((protocol) => protocol.schemes ?? [])
check('no dangerous electron-builder protocols', !protocolSchemes.includes('http') && !protocolSchemes.includes('https'), 'electron-builder protocols must not register http or https')
check('custom vast protocol declared only', protocolSchemes.includes('vast'), 'electron-builder should only declare the custom vast scheme')

check('updater gated by build metadata', /disabledReason/.test(updaterSource) && /VAST_UPDATE_AUTO_DOWNLOAD/.test(updaterSource), 'Updater must be opt-in and diagnosable')
check('updater does not force auto install', !/autoInstallOnAppQuit\s*=\s*true/.test(updaterSource), 'Updater must not force auto install on app quit')
check('updater exposes diagnostics', /getUpdaterDiagnostics/.test(updaterSource) && /vast:updater:status/.test(ipcSource), 'Updater diagnostics must be available through IPC')
check('updater install gated by ready state', /assertInstallAllowed/.test(updaterSource) && /current\.state !== 'ready'/.test(read('src/main/updater-state.ts')), 'Updater install must require a ready/downloaded update')

check('storage creates rolling backups', /copyActiveStorageToBackup\('rolling'\)/.test(storageSource), 'Storage saves must create rolling backups')
check('storage restore validates payloads', /restoreStorageBackup/.test(storageSource) && /isPersistedData\(parsed\)/.test(storageSource), 'Backup restore must validate data before replacing active storage')
check('storage backup API exposed', /vast:storage:list-backups/.test(ipcSource) && /listBackups/.test(preloadSource), 'Backup list/restore/create must be exposed through preload')
check('storage flush API exposed', /vast:storage:flush/.test(ipcSource) && /flush:/.test(preloadSource), 'Renderer must be able to flush pending storage on close')

check('release metadata has no product tiers', !/edition|licenseMode|proBuildEntitlement/.test(buildMetadataSource), 'Build metadata must describe one product')
check('sensitive IPC feature matrix is complete', stableRecord(sensitiveIpcPolicy.featureByChannel) === stableRecord(expectedSensitiveIpcFeatures), 'Every password, network, Video & Audio, and diagnostics handler must have its exact central Labs feature')
check('password IPC vault policy is complete', Object.keys(sensitiveIpcPolicy.featureByChannel).filter((channel) => channel.startsWith('vast:passwords:')).every((channel) => ['control', 'unlocked', 'fresh'].includes(sensitiveIpcPolicy.vaultAccessByChannel[channel])) && Object.keys(sensitiveIpcPolicy.vaultAccessByChannel).every((channel) => sensitiveIpcPolicy.featureByChannel[channel] === 'password-manager'), 'Every Password Manager IPC handler must declare its main-process session access level')
check('sensitive IPC registration fails closed', ipcSource.includes('requiredFeatureForIpcChannel(channel)') && ipcSource.includes('vaultAccessForIpcChannel(channel)') && ipcSource.includes('assertSensitiveIpcRegistrationComplete(registeredChannels)'), 'The main IPC registrar must apply and completeness-check the central policy')
check('enumerated sensitive IPC tests exist', existsSync(join(root, 'tests/main/feature-ipc-gates.test.ts')) && read('tests/main/feature-ipc-gates.test.ts').includes('expectedSensitiveHandlers') && read('tests/main/feature-ipc-gates.test.ts').includes('ts.createSourceFile') && !read('tests/main/feature-ipc-gates.test.ts').includes('assert.match'), 'Sensitive IPC tests must enumerate the parsed handler AST and exact matrix rather than regex-match ipc.ts')
check('product licensing runtime absent', !existsSync(join(root, 'src/main/license.ts')) && !existsSync(join(root, 'src/main/license-cache.ts')) && !existsSync(join(root, 'src/shared/license.ts')) && !/\blicense:\s*\{/.test(typesSource) && !/\blicense:\s*\{/.test(preloadSource), 'Product licensing runtime and preload APIs must be absent')

check('public distribution release guard exists', /assertPublicDistributionGuards/.test(mainSource), 'Main process must guard both public beta and stable release metadata')
check('Cat Addon is excluded through an explicit public-build capability', existsSync(join(root, 'src/main/cat-addon.ts')) && existsSync(join(root, 'resources/cat-addon/cat_addon.zip')) && existsSync(join(root, 'scripts/build-capabilities.cjs')) && afterPackHardeningSource.includes('catAddonEnabled(process.env)') && afterPackHardeningSource.includes("join(resourcesRoot, 'cat-addon')") && buildMetadataSource.includes("'VAST_CAT_ADDON_ENABLED'"), 'Public packaging must omit Cat Addon resources and disable its runtime through VAST_CAT_ADDON_ENABLED while preserving source')
check('release version declarations are consistent', String(pkg.scripts?.['release:version-check'] ?? '').includes('release-version-consistency.cjs') && pkg.version === '0.2.5', 'The 0.2.5 release must have an executable version consistency gate')
check('public beta Relay is explicit staging-only', publicUnsignedBetaWorkflowSource.includes("VAST_RELAY_ENABLED: '1'") && publicUnsignedBetaWorkflowSource.includes("VAST_RELAY_PRODUCTION_ENABLED: '0'") && releaseMetadataWriterSource.includes('https://relay-staging.vastbrowser.com') && releasePackageVerifierSource.includes("metadata.relay?.environment !== 'staging'"), 'The unsigned beta must explicitly enable staging Relay and verify its embedded endpoint and key')
check('Relay staging fixtures are explicitly tagged and always audited during cleanup', relayStagingVerifierSource.includes("instance_kind: 'test'") && relayStagingVerifierSource.includes("AND instance_kind = 'test'") && relayStagingVerifierSource.includes('cleanupErrors') && relayStagingVerifierSource.includes('the explicitly tagged test installation remains in staging') && read('docs/PRIVACY.md').includes('stored `instance_kind` is') && read('docs/PRIVACY.md').includes('exactly `test`'), 'Staging verification must never infer test records and must fail if its precisely tagged fixture cannot be removed')
check('IDU+ and Cat assets are rejected from public packages', releasePackageVerifierSource.includes('first-party-extensions\\/idu-plus') && releasePackageVerifierSource.includes('Cat_85') && releasePackageVerifierSource.includes('asar.listPackage'), 'Final package audit must inspect resources and app.asar for excluded extension assets')
check('all distributed containers are inspected for excluded extension assets', pkg.devDependencies?.['7zip-bin'] === '5.2.0' && releasePackageVerifierSource.includes('Vast-Setup-${version}.exe') && releasePackageVerifierSource.includes('Vast-${version}-Portable.exe') && releasePackageVerifierSource.includes('VastUpdater-${version}.exe') && releasePackageVerifierSource.includes('Vast-${version}-update.zip') && releasePackageVerifierSource.includes('app-\\d+\\.7z') && releasePackageVerifierSource.includes("'7zip-bin'"), 'Installer, portable, updater, update ZIP, nested archives, ASAR, manifests, media, fonts, and .vext files must be audited')
check('Video & Audio public runtime is self-contained and integrity checked', pkg.build?.extraResources?.some((item) => item.from === 'resources/avidae-runtime' && item.to === 'avidae-runtime') && String(pkg.scripts?.['avidae:runtime:prepare'] ?? '').includes('prepare-avidae-runtime.cjs') && avidaeRuntimeBuilderSource.includes("playwright', 'install', '--no-shell', 'chromium") && avidaeRuntimeBuilderSource.includes('FFPROBE') && avidaeRuntimeSource.includes('failed its integrity check'), 'Public packages must bundle and verify Python, one full Playwright Chromium, FFmpeg, and FFprobe instead of relying on host tools')
check('Video & Audio runtime preserves third-party licenses', avidaeRuntimeBuilderSource.includes('licenseFiles') && avidaeRuntimeBuilderSource.includes('FFmpeg-README.txt') && avidaeRuntimeBuilderSource.includes('license.headless_shell') && pythonRuntimeLicenseCollectorSource.includes('python-packages.json') && pythonRuntimeLicenseCollectorSource.includes('No license or notice file found'), 'Generated runtime must inventory and hash FFmpeg, Playwright Chromium, and bundled Python license/notice files')
check('FFmpeg is self-built with complete corresponding source and hard gates', ffmpegLock.ffmpegVersion === '9.0.1' && ffmpegLock.licenseMode === 'gpl-3.0-or-later' && ffmpegLock.sources?.some((source) => source.id === 'x264') && ffmpegLock.buildToolchain?.packages?.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)) && ffmpegLock.buildToolchain?.correspondingSources?.length >= 3 && ffmpegLock.buildToolchain.correspondingSources.every((item) => /^[a-f0-9]{64}$/.test(item.sha256) && /^[a-f0-9]{64}$/.test(item.signatureSha256)) && ffmpegBuilderSource.includes('ffmpeg-corresponding-source-win64.tar.zst') && ffmpegBuilderSource.includes('signatureSha256') && ffmpegComplianceSource.includes('Toolchain source hash does not match') && releasePackageVerifierSource.includes('inspectFfmpegCompliance') && publishedReleaseVerifierSource.includes('ffmpeg-corresponding-source-win64.tar.zst') && publishedReleaseVerifierSource.includes('avidae-ffmpeg-capabilities.json') && publicReleaseWorkflowSource.includes('npm run ffmpeg:build') && publicReleaseWorkflowSource.includes('avidae-ffmpeg-capabilities.json') && publicUnsignedBetaWorkflowSource.includes('npm run ffmpeg:build') && publicUnsignedBetaWorkflowSource.includes('avidae-ffmpeg-capabilities.json'), 'Public releases must use the pinned Vast GPL build, ship exact codec and compiler-runtime source/provenance/capability evidence, and verify actual packaged/downloaded binaries')
check('privacy copy discloses only bounded Relay operational telemetry', existsSync(join(root, 'docs/PRIVACY.md')) && read('docs/PRIVACY.md').includes('no browsing telemetry') && read('docs/PRIVACY.md').includes('anonymous aggregate installation counts') && !read('SECURITY.md').includes('There is no analytics or telemetry.'), 'Privacy docs must distinguish no browsing telemetry from the minimal pseudonymous Relay check-in')
check('spoofing gated by Labs at runtime', mainSource.includes('settingsAllowedByRuntimeFeaturePolicy') && runtimeFeaturePolicySource.includes("settings.labs?.enabled === true && settings.labs.spoofing === true") && runtimeFeaturePolicySource.includes('enabled: false'), 'Spoofing must not apply when Labs spoofing is disabled')
check('Password Manager session lock is main-process enforced', passwordSessionPolicySource.includes("reason: 'startup'") && passwordSessionPolicySource.includes('requireFreshUnlock') && passwordSessionSource.includes("powerMonitor.on('lock-screen'") && passwordSessionSource.includes("powerMonitor.on('suspend'") && passwordSessionSource.includes('getSystemIdleTime()'), 'Vault must start locked and relock on fresh-window expiry, inactivity, screen lock, and suspend')
check('Vast Notices and updater use separate trust domains', trustDomains.updaterOrigins.includes('https://github.com') && noticesTrustSource.includes('must not share the updater trust origin') && noticesSource.includes("session.fromPartition('vast-notices', { cache: false })") && noticesSource.includes("credentials: 'omit'") && !noticesSource.includes("'./updater'") && !updaterSource.includes("'./notices'"), 'Notices must have an independently pinned origin, non-persistent cookieless session, and no updater module dependency')
check('Vast Notices are signed passive JSON only', noticesFeedSource.includes("verify(null") && noticesFeedSource.includes('exactKeys') && noticesFeedSource.includes('forbidden fields') && !noticesSource.includes('shell.') && !noticesSource.includes('executeJavaScript') && !noticesSource.includes('child_process'), 'Notices must verify Ed25519 text-only JSON and expose no execution capability')
check('clean first-launch and migration tests exist', existsSync(join(root, 'tests/main/clean-first-launch.test.ts')) && storageSource.includes('mergePersistedDataForMigration') && read('src/shared/constants.ts').includes('STORAGE_SCHEMA_VERSION = 8'), 'Fresh defaults and additive migration compatibility must be executable contracts')
check('trusted renderer IPC uses exact origin validation', /isTrustedRendererUrl/.test(ipcSecuritySource) && !/localhost:\*/.test(ipcSource), 'IPC trust must not accept arbitrary localhost ports')
check('download URL scheme validation', /isSafeDownloadUrl/.test(ipcSecuritySource) && /Only HTTP\(S\) downloads/.test(ipcSource), 'downloadURL IPC must only accept HTTP(S) URLs')
check('strict app chrome CSP exists', /packagedAppChromeCsp/.test(cspSource) && /default-src 'self'/.test(cspSource) && /frame-ancestors 'none'/.test(cspSource) && /appChromeCsp/.test(sessionsSource), 'App chrome/internal pages must set a strict CSP')
check('CSP blocks dangerous directives', !/script-src[^;\n]*unsafe-eval/.test(cspSource) && /object-src 'none'/.test(cspSource), 'App chrome CSP must not allow unsafe eval or objects')
check('packaged CSP brokers network through main', /packagedAppChromeCsp/.test(cspSource) && /connect-src 'self'/.test(cspSource) && !/packagedAppChromeCsp[^\n]*https:/.test(cspSource), 'Packaged app chrome must not grant arbitrary renderer HTTPS connections')
check('updater dry run is non-mutating', /if \(-not \$DryRun\) \{[\s\S]*New-Item -ItemType Directory -Path \$runtimeBackupRoot/.test(read('release/Updater/VastUpdater.ps1')), 'Updater dry run must not create a runtime transaction or backup')

check('desktop and Hub share a strict Chrome match-pattern parser', desktopExtensionManifestSource.includes("../../shared/extension-match-pattern") && hubValidationSource.includes("../../src/shared/extension-match-pattern") && extensionMatchPatternSource.includes("scheme === '*'" ) && extensionMatchPatternSource.includes('hostname') && extensionMatchPatternSource.includes('path'), 'Extension URL scope must be parsed once with strict scheme, host, wildcard, and path rules')
check('Hub Windows archive paths are fail-closed', vextFormatSource.includes('/[<>:"|?*]/') && vextFormatSource.includes('reservedWindowsNames') && vextFormatSource.includes("segment === '..'") && vextFormatSource.includes('new Set(files.map((file) => file.path.toLowerCase()))') && vextFormatSource.includes('maxCompressionRatio'), '.vext validation must reject forbidden Windows paths, reserved names, collisions, traversal, and archive abuse')
check('Hub dynamic-code policy uses AST review', pkg.devDependencies?.acorn === '8.18.0' && hubValidationSource.includes("from 'acorn'") && hubValidationSource.includes("node.type === 'CallExpression'") && hubValidationSource.includes('WebAssembly') && hubValidationSource.includes('manual review required'), 'Hub validation must parse and walk JavaScript ASTs, block dynamic/remote code and flag obfuscation for human review')
check('Hub download HEAD is read-only', hubIndexSource.includes("request.method === 'HEAD'") && hubIndexSource.includes('env.PACKAGES.head(key)') && hubIndexSource.includes('download_counters'), 'HEAD package requests must use metadata-only R2 access and must not increment catalog download counts')
check('Hub media is decoded and canonically re-encoded', hubWranglerSource.includes('"binding": "IMAGES"') && hubIndexSource.includes('env.IMAGES.input') && hubIndexSource.includes("output({ format: 'image/webp'") && hubIndexSource.includes('info.width * info.height > 40_000_000'), 'Catalog media must pass decoded dimension/pixel limits and canonical WebP re-encoding before R2 storage')
check('Hub Publisher Terms and warranties fail closed', hubLegalSource.includes('requireLegalConfig') && hubLegalSource.includes('LEGAL_PLACEHOLDER') && hubWranglerSource.includes('"HUB_LEGAL_OPERATOR_NAME": "Jan Nowacki"') && hubWranglerSource.includes('"HUB_LEGAL_CONTACT_URL": "https://vastbrowser.com/legal"') && hubLegalSource.includes('terms_sha256') && hubIndexSource.includes('requirePublisherTerms') && hubIndexSource.includes('warrantyAccepted') && hubMigrationSource.includes('publisher_terms_acceptances'), 'Publishing must require validated legal configuration, versioned/hash-bound terms acceptance, and submit-time warranty confirmation')
check('Hub listings disclose data practices and remote services', hubMigrationSource.includes('data_practice') && hubMigrationSource.includes('privacy_policy_url') && hubMigrationSource.includes('remote_services') && hubValidationSource.includes('external-processing') && hubValidationSource.includes('privacyPolicyUrl') && hubIndexSource.includes('updateExtensionDataPractice'), 'External processing must be disclosed with remote services and an HTTPS privacy policy; local-only and migrated legacy listings must have an explicit update path')
check('Hub reports are human-reviewed and auditable', hubMigrationSource.includes('extension_reports') && hubMigrationSource.includes('legal_hold') && hubIndexSource.includes('reportReviewPage') && hubIndexSource.includes('publisherNotified') && hubIndexSource.includes('report-received'), 'Public reports must be bounded, reviewed without automatic delisting, and retain decision/notification/evidence audit data')
check('Hub security envelope includes HSTS and hardened cookies', hubSecuritySource.includes('strict-transport-security') && hubSecuritySource.includes('HttpOnly') && hubSecuritySource.includes('SameSite=Strict') && hubSecuritySource.includes('content-security-policy') && hubSecuritySource.includes('permissions-policy'), 'Hub edge responses and authentication cookies must carry the tested security envelope')
check('manual Hub staging edge gate is read-only', hubStagingEdgeWorkflowSource.includes('workflow_dispatch') && hubStagingEdgeWorkflowSource.includes('extensions-hub-staging') && hubStagingEdgeVerifierSource.includes('HUB_STAGING_ORIGIN') && hubStagingEdgeVerifierSource.includes("method: 'GET'") && !hubStagingEdgeVerifierSource.includes("method: 'POST'") && !hubStagingEdgeWorkflowSource.includes('wrangler deploy'), 'Live edge verification must target an existing non-production staging origin without deployment or mutation')
check('Hub staging uses isolated resources and no scheduled cleanup', hubWranglerSource.includes('extensions-staging.vastbrowser.com') && hubWranglerSource.includes('vast-extensions-hub-staging') && hubWranglerSource.includes('vast-extensions-packages-staging') && hubWranglerSource.includes('"triggers": { "crons": [] }'), 'Hub staging must use distinct D1/R2 resources and must not inherit production cron triggers')
check('CI runs full-history secret scanning and release gates', windowsCiSource.includes('gitleaks/gitleaks-action@dcedce43c6f43de0b836d1fe38946645c9c638dc') && windowsCiSource.includes('fetch-depth: 0') && windowsCiSource.includes('npm run ffmpeg:build') && windowsCiSource.includes('npm run avidae:runtime:prepare') && windowsCiSource.includes('npm run release:audit') && windowsCiSource.includes('npm run release:version-check') && windowsCiSource.includes('npm run test:electron-version') && windowsCiSource.includes('npm run hub:build') && windowsCiSource.includes('npm run test:package:ci') && windowsCiSource.includes('python -m unittest tests/avidae/avidae_security_test.py'), 'CI must scan full history with pinned Gitleaks and execute the FFmpeg, release, Electron, Hub, Avidae, and packaging checks')
check('0.2.5 readiness report records resolved blockers and remaining gates truthfully', releaseReadinessSource.includes('FFmpeg corresponding source | **PASS**') && releaseReadinessSource.includes('Verified legal operator and contact | **PASS**') && releaseReadinessSource.includes('Live Extensions Hub staging edge | **PASS**') && releaseReadinessSource.includes('extensions-staging.vastbrowser.com') && releaseReadinessSource.includes('Authenticode availability | **BLOCKED FOR SIGNED RELEASE**') && releaseReadinessSource.includes('FFmpeg redistribution and Hub legal-operator task: PASS'), 'Readiness must record the verified FFmpeg, legal and isolated staging results while retaining the signing/unsigned authorization gate')

for (const doc of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ROADMAP.md', 'RELEASE.md', 'docs/OPEN_SOURCE_LICENSE_AUDIT.md', 'docs/OPEN_SOURCE_READINESS.md', 'docs/RELEASE_0.2.5_READINESS.md', 'docs/RELEASE_CHECKLIST.md', 'docs/FEATURE_STATUS.md', 'docs/IPC_SECURITY.md']) {
  check(`doc exists: ${doc}`, existsSync(join(root, doc)), `${doc} should exist`)
}

const failed = checks.filter((item) => !item.pass)
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
if (failed.length > 0) process.exit(1)
