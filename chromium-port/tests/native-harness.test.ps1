$ErrorActionPreference = 'Stop'
$portRoot = Split-Path -Parent $PSScriptRoot
$harness = Join-Path $PSScriptRoot 'native-capabilities-smoke.mjs'
$webUIHarness = Join-Path $PSScriptRoot 'vast-webui-smoke.mjs'
$mojoPatch = Join-Path $portRoot 'patches\0005-vast-mojo-runtime-info.patch'
$migrationPatch = Join-Path $portRoot 'patches\0006-vast-data-migration-preview.patch'
$dataRootPatch = Join-Path $portRoot 'patches\0007-vast-data-root-resolution.patch'
$migrationTestPatch = Join-Path $portRoot 'patches\0008-vast-data-migration-unittests.patch'
$migrationTransactionPatch = Join-Path $portRoot 'patches\0009-vast-data-migration-transaction.patch'
$migrationWebUIPatch = Join-Path $portRoot 'patches\0010-vast-migration-transaction-webui.patch'
$backupExtractorPatch = Join-Path $portRoot 'patches\0011-vast-backup-v1-extractor.patch'
$backupAuditPatch = Join-Path $portRoot 'patches\0012-vast-native-backup-audit-tool.patch'
$backupWebUIPatch = Join-Path $portRoot 'patches\0013-vast-backup-fixture-webui-transaction.patch'
$projectionPatch = Join-Path $portRoot 'patches\0014-vast-workspace-settings-projection.patch'
$productRootPatch = Join-Path $portRoot 'patches\0015-vast-product-data-root-recovery.patch'
$productRootWebUIPatch = Join-Path $portRoot 'patches\0016-vast-product-root-webui-restart.patch'
$keyedServicePatch = Join-Path $portRoot 'patches\0017-vast-profile-keyed-data-service.patch'
$nativeShellPatch = Join-Path $portRoot 'patches\0018-vast-native-shell-new-tab.patch'
$nativeToolbarPatch = Join-Path $portRoot 'patches\0019-vast-native-workspace-toolbar.patch'
$workspaceSelectionPatch = Join-Path $portRoot 'patches\0020-vast-workspace-selection.patch'
$workspaceTabGroupsPatch = Join-Path $portRoot 'patches\0021-vast-native-workspace-tab-groups.patch'
$workspaceGroupRegistryPatch = Join-Path $portRoot 'patches\0022-vast-workspace-group-registry.patch'
$nativeToolbarSmoke = Join-Path $portRoot 'scripts\vast-toolbar-smoke-test.ps1'
$nativeToolbarFixtureHarness = Join-Path $portRoot 'tests\commit-vast-fixture.mjs'
$verificationRunner = Join-Path $portRoot 'scripts\verify-build.ps1'
& node.exe --check $harness
if ($LASTEXITCODE -ne 0) { throw 'native capability smoke harness has JavaScript syntax errors' }
& node.exe --check $webUIHarness
if ($LASTEXITCODE -ne 0) { throw 'Vast WebUI smoke harness has JavaScript syntax errors' }
& node.exe --check $nativeToolbarFixtureHarness
if ($LASTEXITCODE -ne 0) { throw 'Vast native toolbar fixture harness has JavaScript syntax errors' }
$source = Get-Content -LiteralPath $harness -Raw
foreach ($required in @(
  'DevToolsActivePort',
  'navigator.serviceWorker.register',
  'vastSmoke=persisted',
  'Browser.setDownloadBehavior',
  'navigator.permissions.query',
  'VastNativeCapabilities-'
)) {
  if ($source -notmatch [regex]::Escape($required)) { throw "native harness is missing: $required" }
}
if ($source -match 'from\s+[''"]electron' -or $source -match 'require\([''"]electron') {
  throw 'native capability harness must not depend on Electron'
}
$webUISource = Get-Content -LiteralPath $webUIHarness -Raw
foreach ($required in @(
  'chrome://vast/',
  'vastReady',
  'Electron runtime absent',
  'invalidMigrationRejected',
  'invalidDataRootRejected',
  'migrationTransactionCommitted',
  'migrationTransactionRolledBack',
  '--vast-enable-migration-fixture-commit',
  '--backup-fixture=',
  'backupFixtureAudited',
  'productRootActivatedAndCleared',
  'productRootRecoveredAfterRestart',
  'root-selection.json',
  'FatalWaitError',
  '--browser-logs',
  'Password vault detected but excluded from preview.',
  'Page.captureScreenshot',
  'newTabRouteVerified',
  'workspaceProjectionRenderedAfterRestart',
  'workspaceSelectionPersistedAfterRestart',
  'workspace-selection.json',
  '--projection-screenshot='
)) {
  if ($webUISource -notmatch [regex]::Escape($required)) { throw "Vast WebUI harness is missing: $required" }
}
$mojoPatchSource = Get-Content -LiteralPath $mojoPatch -Raw
foreach ($required in @(
  'vast.mojom',
  'MojoWebUIController',
  'RegisterWebUIControllerInterfaceBinder',
  'GetRuntimeInfo',
  'PageHandlerFactory.getRemote()',
  'handler.getRuntimeInfo()'
)) {
  if ($mojoPatchSource -notmatch [regex]::Escape($required)) { throw "Vast Mojo patch is missing: $required" }
}
$migrationPatchSource = Get-Content -LiteralPath $migrationPatch -Raw
foreach ($required in @(
  'kMaxStorageBytes = 8 * 1024 * 1024',
  'vast-migration-fixture',
  'password_vault_present',
  'ThreadPool::PostTaskAndReplyWithResult',
  'base::MayBlock()',
  'GetMigrationPreview'
)) {
  if ($migrationPatchSource -notmatch [regex]::Escape($required)) { throw "Vast migration preview patch is missing: $required" }
}
$dataRootPatchSource = Get-Content -LiteralPath $dataRootPatch -Raw
foreach ($required in @(
  'data-root.json',
  'customDataRoot',
  'kMaxDataRootConfigBytes = 64 * 1024',
  'configured_root.IsAbsolute()',
  'ReadVastDataMigrationPreviewFromConfigRoot'
)) {
  if ($dataRootPatchSource -notmatch [regex]::Escape($required)) { throw "Vast data-root patch is missing: $required" }
}
$migrationTestPatchSource = Get-Content -LiteralPath $migrationTestPatch -Raw
foreach ($required in @(
  'test("vast_data_unittests")',
  'ReadsDefaultRootAndOnlyDetectsVault',
  'ResolvesAbsoluteCustomDataRoot',
  'RejectsRelativeCustomDataRoot',
  'RejectsMalformedVastData',
  'RejectsVastDataLargerThanEightMiB'
)) {
  if ($migrationTestPatchSource -notmatch [regex]::Escape($required)) { throw "Vast migration unit-test patch is missing: $required" }
}
$migrationTransactionPatchSource = Get-Content -LiteralPath $migrationTransactionPatch -Raw
foreach ($required in @(
  'PrepareVastDataMigration',
  'CommitVastDataMigration',
  'RollbackVastDataMigration',
  'kMaxMigrationTotalBytes = 512 * 1024 * 1024',
  'crypto::hash::Sha256',
  'safety-backup',
  'migration-journal.json',
  'PreparesCommitsAndRollsBackWithoutChangingSource',
  'must not migrate'
)) {
  if ($migrationTransactionPatchSource -notmatch [regex]::Escape($required)) { throw "Vast migration transaction patch is missing: $required" }
}
$migrationWebUIPatchSource = Get-Content -LiteralPath $migrationWebUIPatch -Raw
foreach ($required in @(
  'vast-enable-migration-fixture-commit',
  'vast-migration-transaction-parent',
  'RunMigrationFixtureTransaction',
  'RollbackMigrationFixtureTransaction',
  'Explicit migration confirmation is required.',
  'migration_fixture_commit_enabled',
  'migrationTransaction'
)) {
  if ($migrationWebUIPatchSource -notmatch [regex]::Escape($required)) { throw "Vast migration WebUI patch is missing: $required" }
}
$backupExtractorPatchSource = Get-Content -LiteralPath $backupExtractorPatch -Raw
foreach ($required in @(
  'ExtractVastBackupProductData',
  'kMaxArchiveBytes = 512 * 1024 * 1024',
  'kMaxEntryBytes = 256 * 1024 * 1024',
  'kMaxTotalUncompressedBytes = 2ULL * 1024 * 1024 * 1024',
  'kMaxArchiveEntries = 10000',
  'ZipReader',
  'crypto::hash::kSha256',
  'IsVastProductDataRelativePath',
  'VerifiesAllFilesExtractsOnlyProductDataAndFeedsTransaction',
  'RejectsZipSlipBeforeExtraction'
)) {
  if ($backupExtractorPatchSource -notmatch [regex]::Escape($required)) { throw "Vast backup extractor patch is missing: $required" }
}
$backupAuditPatchSource = Get-Content -LiteralPath $backupAuditPatch -Raw
foreach ($required in @(
  'executable("vast_backup_audit")',
  'ExtractVastBackupProductData',
  'temporaryDataCleaned',
  'DeletePathRecursively',
  'verifiedFiles',
  'passwordVaultPresent'
)) {
  if ($backupAuditPatchSource -notmatch [regex]::Escape($required)) { throw "Vast native backup audit patch is missing: $required" }
}
$backupWebUIPatchSource = Get-Content -LiteralPath $backupWebUIPatch -Raw
foreach ($required in @(
  'vast-backup-fixture',
  'archive_source',
  'verified_archive_files',
  'selected_product_files',
  'ReadMigrationPreviewOnWorker',
  'ExtractVastBackupProductData',
  'Only one development migration source may be configured.',
  'temporary data cleanup failed'
)) {
  if ($backupWebUIPatchSource -notmatch [regex]::Escape($required)) { throw "Vast backup WebUI transaction patch is missing: $required" }
}
$projectionPatchSource = Get-Content -LiteralPath $projectionPatch -Raw
foreach ($required in @(
  'ReadVastDataProjection',
  'VastWorkspaceProjection',
  'VastSettingsProjection',
  'workspace_ids.insert',
  'active_workspace_found',
  'FallsBackForUnsupportedSettings',
  'RejectsDuplicateWorkspaceIds',
  'RejectsMissingActiveWorkspace',
  'excludes tab URLs, history, notes, secrets'
)) {
  if ($projectionPatchSource -notmatch [regex]::Escape($required)) { throw "Vast workspace/settings projection patch is missing: $required" }
}
$productRootPatchSource = Get-Content -LiteralPath $productRootPatch -Raw
foreach ($required in @(
  'ActivateVastProductDataRoot',
  'RecoverVastProductDataRoot',
  'DeactivateVastProductDataRoot',
  'VastProductData/root-selection.json',
  'migration-journal.json',
  '.vast-migration-',
  'Recovered Vast product data failed SHA-256 verification.',
  'safety_backup_root.Append',
  'PersistsRecoversRollsBackAndClearsWithoutChangingSource',
  'RejectsDestinationChangedAfterActivation'
)) {
  if ($productRootPatchSource -notmatch [regex]::Escape($required)) { throw "Vast product-root recovery patch is missing: $required" }
}
$productRootWebUIPatchSource = Get-Content -LiteralPath $productRootWebUIPatch -Raw
foreach ($required in @(
  'GetProductDataStatus',
  'ProductDataStatus',
  'WorkspaceProjection',
  'SettingsProjection',
  'ActivateVastProductDataRoot',
  'RecoverVastProductDataRoot',
  'DeactivateVastProductDataRoot',
  'profile_path_',
  'Filesystem paths, journal contents',
  "dataset['productData'] = 'recovered'"
)) {
  if ($productRootWebUIPatchSource -notmatch [regex]::Escape($required)) { throw "Vast product-root WebUI restart patch is missing: $required" }
}
$keyedServicePatchSource = Get-Content -LiteralPath $keyedServicePatch -Raw
foreach ($required in @(
  'VastProductDataService : public KeyedService',
  'VastProductDataServiceFactory : public ProfileKeyedServiceFactory',
  'ProfileSelection::kOwnInstance',
  'ChromeBrowserMainExtraPartsProfiles',
  'VastProductDataServiceFactory::GetInstance',
  'product_data_service_->GetStatus',
  'product_data_service_->Invalidate',
  'reload_after_recovery_',
  'SharesCachedStatusAndRevalidatesOnDemand'
)) {
  if ($keyedServicePatchSource -notmatch [regex]::Escape($required)) { throw "Vast profile-keyed product-data service patch is missing: $required" }
}
$nativeShellPatchSource = Get-Content -LiteralPath $nativeShellPatch -Raw
foreach ($required in @(
  'GURL(chrome::kChromeUIVastURL)',
  'BUILDFLAG(VAST_BRANDING)',
  'AddVastColorMixer',
  'ContrastMode::kHigh',
  'test("vast_color_mixer_unittests")',
  'PreservesHighContrastPalette',
  'data-testid="vast-home"',
  'renderWorkspaceRail',
  'https://www.google.com/search'
)) {
  if ($nativeShellPatchSource -notmatch [regex]::Escape($required)) { throw "Vast native-shell patch is missing: $required" }
}
$nativeToolbarPatchSource = Get-Content -LiteralPath $nativeToolbarPatch -Raw
foreach ($required in @(
  'class VastWorkspaceButton : public ToolbarChipButton',
  'kVastWorkspaceIcon',
  'IsRegularProfile',
  'AddStatusChangedCallback',
  'status_changed_callbacks_.Notify',
  'Private Vast workspace:',
  'kChromeUIVastURL',
  'SharesCachedStatusAndRevalidatesOnDemand'
)) {
  if ($nativeToolbarPatchSource -notmatch [regex]::Escape($required)) { throw "Vast native workspace-toolbar patch is missing: $required" }
}
$workspaceSelectionPatchSource = Get-Content -LiteralPath $workspaceSelectionPatch -Raw
foreach ($required in @(
  'PersistVastWorkspaceSelection',
  'SelectWorkspace',
  'workspace-selection.json',
  'journalPath',
  'AddRadioItem',
  'SelectsWorkspaceWithoutChangingImportedDataAndSurvivesRestart'
)) {
  if ($workspaceSelectionPatchSource -notmatch [regex]::Escape($required)) { throw "Vast workspace-selection patch is missing: $required" }
}
$workspaceTabGroupsPatchSource = Get-Content -LiteralPath $workspaceTabGroupsPatch -Raw
foreach ($required in @(
  'class VastWorkspaceTabController : public TabStripModelObserver',
  'AddToNewGroup',
  'AddToExistingGroup',
  'ChangeTabGroupVisuals',
  'Vast · ',
  'data:text/html,<title>Vast%20Workspace</title>',
  'never receives or persists URLs',
  'never claim or rename an unrelated native group'
)) {
  if ($workspaceTabGroupsPatchSource -notmatch [regex]::Escape($required)) { throw "Vast workspace tab-groups patch is missing: $required" }
}
$workspaceGroupRegistryPatchSource = Get-Content -LiteralPath $workspaceGroupRegistryPatch -Raw
foreach ($required in @(
  'workspace-tab-groups.json',
  'LoadVastWorkspaceGroupRegistry',
  'UpdateVastWorkspaceGroupRegistration',
  'SerializesWorkspaceGroupUpdatesAndReloadsAfterRestart',
  'change.type() != TabStripModelChange::kInserted',
  'TabGroupId::FromRawToken',
  'role="group" aria-label="Projected settings"',
  'GURL(chrome::kChromeUIVastURL)',
  'AssignExistingUngroupedTabs'
)) {
  if ($workspaceGroupRegistryPatchSource -notmatch [regex]::Escape($required)) { throw "Vast workspace group-registry patch is missing: $required" }
}
$nativeToolbarSmokeSource = Get-Content -LiteralPath $nativeToolbarSmoke -Raw
foreach ($required in @(
  'UIAutomationClient',
  'Open Vast workspace hub',
  'InvokePattern',
  'WorkspaceMenuFixture',
  'Beta (private)',
  'workspaceSelectionPersistedAfterRestart',
  'Wait-VastNativeTabGroups',
  'nativeTabGroupsVerified',
  'workspaceGroupRegistryVerified',
  'nativeTabGroupsRestoredAfterRestart',
  'registeredGroupTokensRetainedAfterRestart',
  'workspace-tab-groups.json',
  'RejectUnnamedGroup',
  '*Crashed*',
  'other tab*',
  'chrome://vast/',
  'VastToolbarSmoke-'
)) {
  if ($nativeToolbarSmokeSource -notmatch [regex]::Escape($required)) { throw "Vast native toolbar smoke test is missing: $required" }
}
$runnerSource = Get-Content -LiteralPath $verificationRunner -Raw
foreach ($required in @(
  'stage-artifacts.ps1',
  'smoke-test.ps1',
  'capability-smoke-test.ps1',
  'vast-webui-smoke-test.ps1',
  'vast-toolbar-smoke-test.ps1',
  'WorkspaceMenuFixture = $true',
  'build-report.ps1',
  'TimeoutSeconds = 300',
  "ProductName -ne 'Vast'",
  "New-VastReportPath 'phase2-acceptance'",
  'launchSmokeReport',
  'capabilitySmokeReport',
  'vastWebUIReport',
  'vastToolbarReport'
)) {
  if ($runnerSource -notmatch [regex]::Escape($required)) { throw "native verification runner is missing: $required" }
}
Write-Host 'PASS native Chromium capability harness structure'
