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
const avidaeRuntimeSource = read('src/main/avidae-runtime.ts')
const avidaeRuntimeBuilderSource = read('scripts/prepare-avidae-runtime.cjs')
const pythonRuntimeLicenseCollectorSource = read('scripts/copy-python-runtime-licenses.py')
const releaseMetadataWriterSource = read('scripts/write-release-build-metadata.cjs')
const updaterSignerSource = read('scripts/sign-windows-updater.cjs')
const windowsIconHookSource = read('scripts/apply-windows-icon.cjs')
const localReleaseSource = read('scripts/local-release-from-env.cjs')
const afterPackHardeningSource = read('scripts/after-pack-hardening.cjs')
const fuseHookSource = read('scripts/electron-fuses.cjs')
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
check('security-patched release dependencies pinned', pkg.dependencies?.['electron-updater'] === '6.8.9' && pkg.dependencies?.['pdfjs-dist'] === '6.2.108' && pkg.devDependencies?.['electron-builder'] === '26.15.3' && pkg.devDependencies?.postcss === '8.5.25' && pkg.devDependencies?.['@electron/fuses'] === '2.1.2', 'Updater, PDF renderer, packager, CSS tooling, and fuse tooling must remain on the audited patched versions')
check('npm audit is a CI gate for client and Relay', String(pkg.scripts?.['audit:ci'] ?? '').includes('npm audit --audit-level=high') && String(pkg.scripts?.['audit:ci'] ?? '').includes('npm audit --prefix relay --audit-level=high') && read('.github/workflows/windows-ci.yml').includes('npm run audit:ci'), 'CI must reject HIGH or CRITICAL npm advisories in both lockfiles')
check('public signing fails closed', pkg.build?.forceCodeSigning === true && /electron-builder-private-unsigned\.cjs/.test(read('scripts/build-release.cjs')), 'Signed public builds must require signing while explicit private QA builds may opt out')
check('hardening hook runs before signing', pkg.build?.afterPack === 'scripts/after-pack-hardening.cjs' && afterPackHardeningSource.indexOf('applyWindowsIcon(context)') < afterPackHardeningSource.indexOf('applyElectronFuses(context)') && /packager\?\.getIconPath/.test(windowsIconHookSource), 'Icon resources and Electron fuses must be applied in afterPack before signing')
check('required Electron fuses are fail-closed', REQUIRED_ELECTRON_FUSES.RunAsNode === false && REQUIRED_ELECTRON_FUSES.EnableNodeOptionsEnvironmentVariable === false && REQUIRED_ELECTRON_FUSES.EnableNodeCliInspectArguments === false && REQUIRED_ELECTRON_FUSES.EnableEmbeddedAsarIntegrityValidation === true && REQUIRED_ELECTRON_FUSES.OnlyLoadAppFromAsar === true && fuseHookSource.includes('strictlyRequireAllFuses: true') && fuseHookSource.includes('assertFuseState'), 'Packaged Electron must disable Node/inspect escape hatches and verify ASAR-only integrity fuses')
check('real Electron fuse integration check exists', String(pkg.scripts?.['test:fuses:integration'] ?? '').includes('test-electron-fuses-integration.cjs') && existsSync(join(root, 'scripts/test-electron-fuses-integration.cjs')) && existsSync(join(root, 'scripts/verify-electron-fuses.cjs')), 'The fuse profile must be executable against and readable from real Electron binaries')
check('github publish target configured', pkg.build?.publish?.owner === 'vstxx' && pkg.build?.publish?.repo === 'vast-public', 'GitHub publish target must be vstxx/vast-public')
check('dist uses obfuscation pipeline', String(pkg.scripts?.dist ?? '').includes('build:obfuscated'), 'dist script should run build:obfuscated')
check('public release command builds one updater package', String(pkg.scripts?.['dist:public'] ?? '').includes('dist:upgrader') && String(pkg.scripts?.['release:stable'] ?? '').includes('dist:upgrader') && String(pkg.scripts?.[`release:windows:${pkg.version}`] ?? '').includes('dist:upgrader'), 'Public release scripts must route to the single installer plus updater package')
check('release package verifier exists', /VastUpdater-\$\{version\}\.exe/.test(releasePackageVerifierSource) && /Vast-Setup-\$\{version\}\.exe/.test(releasePackageVerifierSource), 'Release package verifier must require expected EXEs')
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
check('signed public upgrade gate exists', existsSync(join(root, 'tests/updater/vast-public-beta-upgrade.test.ps1')) && publicReleaseWorkflowSource.includes('vast-public-beta-upgrade.test.ps1') && read('tests/updater/vast-public-beta-upgrade.test.ps1').includes('Relay install ID must survive the upgrade'), 'Public distribution must verify signed previous-to-current upgrade and preserve user data')
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
const publicSourceExport = existsSync(join(root, 'PUBLIC_SOURCE_EXPORT.md'))
const catAddonSourcePresent = existsSync(join(root, 'src/main/cat-addon.ts'))
const catAddonArchivePresent = existsSync(join(root, 'resources/cat-addon/cat_addon.zip'))
const catAddonPackaged = pkg.build?.extraResources?.some((item) => item.from === 'resources/cat-addon')
check(
  'Cat Addon publication boundary is fail-closed without deleting source',
  catAddonSourcePresent &&
    afterPackHardeningSource.includes("VAST_RELEASE_CHANNEL !== 'beta'") &&
    afterPackHardeningSource.includes("join(resourcesRoot, 'cat-addon')") &&
    buildMetadataSource.includes("catAddonAvailable: channel !== 'beta'") &&
    (publicSourceExport ? !catAddonArchivePresent && !catAddonPackaged : catAddonArchivePresent),
  'The private tree may retain the package for non-beta builds; the public export must omit unlicensed artwork and packaging while retaining source'
)
check('Video & Audio public runtime is self-contained and integrity checked', pkg.build?.extraResources?.some((item) => item.from === 'resources/avidae-runtime' && item.to === 'avidae-runtime') && String(pkg.scripts?.['avidae:runtime:prepare'] ?? '').includes('prepare-avidae-runtime.cjs') && avidaeRuntimeBuilderSource.includes("playwright', 'install', 'chromium") && avidaeRuntimeBuilderSource.includes('FFPROBE') && avidaeRuntimeSource.includes('failed its integrity check'), 'Public packages must bundle and verify Python, Chromium, FFmpeg, and FFprobe instead of relying on host tools')
check('Video & Audio runtime preserves third-party licenses', avidaeRuntimeBuilderSource.includes('licenseFiles') && avidaeRuntimeBuilderSource.includes('FFmpeg-README.txt') && avidaeRuntimeBuilderSource.includes('license.headless_shell') && pythonRuntimeLicenseCollectorSource.includes('python-packages.json') && pythonRuntimeLicenseCollectorSource.includes('No license or notice file found'), 'Generated runtime must inventory and hash FFmpeg, Playwright Chromium, and bundled Python license/notice files')
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
check('updater dry run is non-mutating', /if \(-not \$DryRun\) \{[\s\S]*New-Item -ItemType Directory -Path \$runtimeBackupRoot/.test(read('release/Updater/VastUpdater.ps1')), 'Updater dry run must not create a runtime transaction or backup')

for (const doc of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ROADMAP.md', 'RELEASE.md', 'docs/OPEN_SOURCE_LICENSE_AUDIT.md', 'docs/OPEN_SOURCE_READINESS.md', 'docs/RELEASE_CHECKLIST.md', 'docs/FEATURE_STATUS.md', 'docs/IPC_SECURITY.md']) {
  check(`doc exists: ${doc}`, existsSync(join(root, doc)), `${doc} should exist`)
}

const failed = checks.filter((item) => !item.pass)
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
if (failed.length > 0) process.exit(1)
