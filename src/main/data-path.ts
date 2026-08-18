import { shell } from 'electron/common'
import { app, dialog, type BrowserWindow } from 'electron/main'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DataPathInfo, MigrationReport } from '../shared/types'
import {
  copyDataRootForMigration,
  dataPathConfigFile,
  readConfiguredDataRoot,
  stableConfigRootFromEnv,
  validateDataRootCandidate,
  writeConfiguredDataRoot
} from './data-path-utils'
import { createVastBackupArchive, extractVastBackupArchive } from './vast-backup'

const productDataDirName = 'Vast'
const devDataDirName = 'Vast Dev'

function configuredRootSync(configRoot: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(dataPathConfigFile(configRoot), 'utf8')) as { customDataRoot?: unknown }
    return typeof parsed.customDataRoot === 'string' && parsed.customDataRoot.trim()
      ? resolve(parsed.customDataRoot)
      : undefined
  } catch {
    return undefined
  }
}

export function defaultVastDataRoot(): string {
  if (!app.isPackaged) {
    return process.env.VAST_TEST_USER_DATA_DIR || process.env.VAST_DEV_USER_DATA_DIR || join(app.getPath('appData'), devDataDirName)
  }
  return join(app.getPath('appData'), productDataDirName)
}

export function stableDataPathConfigRoot(): string {
  return stableConfigRootFromEnv()
}

function setVastProfileRoot(root: string): void {
  mkdirSync(root, { recursive: true })
  app.setPath('userData', root)
  // Keep Chromium cookies/storage pinned to the same stable root even if
  // Electron changes how sessionData follows a userData override.
  app.setPath('sessionData', root)
}

export function configureVastUserDataPath(): void {
  const envOverride = process.env.VAST_TEST_USER_DATA_DIR || process.env.VAST_DEV_USER_DATA_DIR
  if (envOverride) {
    setVastProfileRoot(envOverride)
    return
  }
  if (!app.isPackaged) {
    setVastProfileRoot(defaultVastDataRoot())
    return
  }
  const customRoot = configuredRootSync(stableDataPathConfigRoot())
  if (!customRoot) {
    setVastProfileRoot(defaultVastDataRoot())
    return
  }
  try {
    setVastProfileRoot(customRoot)
  } catch (error) {
    console.warn('[data-path] Ignoring configured custom data directory:', error)
    setVastProfileRoot(defaultVastDataRoot())
  }
}

export function vastDataPath(): string {
  return app.getPath('userData')
}

export function dataFilePath(fileName: string): string {
  return join(vastDataPath(), fileName)
}

export async function getDataPathInfo(): Promise<DataPathInfo> {
  const configured = await readConfiguredDataRoot(stableDataPathConfigRoot())
  const current = vastDataPath()
  return {
    currentDataPath: current,
    defaultDataPath: defaultVastDataRoot(),
    stableConfigPath: dataPathConfigFile(stableDataPathConfigRoot()),
    customDataPathActive: Boolean(configured && resolve(configured) === resolve(current)),
    configuredCustomDataPath: configured,
    appInstallPath: app.isPackaged ? dirname(process.execPath) : process.cwd()
  }
}

export async function openCurrentDataFolder(): Promise<void> {
  const error = await shell.openPath(vastDataPath())
  if (error) throw new Error(error)
}

function releaseAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return 'unknown'
  }
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function createMigrationBackup(kind: 'pre-import' | 'pre-data-dir-change'): Promise<string> {
  const destination = join(stableDataPathConfigRoot(), 'migration-backups', `${kind}-${timestampSlug()}.vastbackup`)
  await createVastBackupArchive({
    dataRoot: vastDataPath(),
    destinationPath: destination,
    appVersion: releaseAppVersion(),
    appId: 'app.vast.browser',
    platform: process.platform
  })
  return destination
}

function relaunchWithNewDataPath(): void {
  app.relaunch()
  app.quit()
}

export async function chooseAndMigrateDataDirectory(mainWindow: BrowserWindow): Promise<MigrationReport> {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Vast data directory',
    properties: ['openDirectory', 'createDirectory']
  })
  if (choice.canceled || !choice.filePaths[0]) return { ok: false, error: 'Data directory change cancelled.' }

  const info = await getDataPathInfo()
  const validation = await validateDataRootCandidate(choice.filePaths[0], {
    currentDataRoot: info.currentDataPath,
    defaultDataRoot: info.defaultDataPath,
    installRoot: info.appInstallPath
  })
  if (!validation.ok) return { ok: false, error: validation.error }

  const confirmed = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Change Vast data directory',
    message: 'Move Vast data to the selected directory and restart?',
    detail: 'Vast will create a full backup first, copy the current profile, then switch to the new directory. The old data folder is left untouched.',
    buttons: ['Move data and restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (confirmed.response !== 0) return { ok: false, error: 'Data directory change cancelled.' }

  const backupPath = await createMigrationBackup('pre-data-dir-change')
  const copyReport = await copyDataRootForMigration(info.currentDataPath, validation.path)
  await writeConfiguredDataRoot(stableDataPathConfigRoot(), validation.path)
  setTimeout(relaunchWithNewDataPath, 250)
  return {
    ok: true,
    dataPath: validation.path,
    backupPath,
    copiedFiles: copyReport.copiedFiles,
    skippedFiles: copyReport.skippedFiles,
    restartRequired: true,
    warnings: ['Vast is restarting into the selected data directory. The previous data folder was not deleted.']
  }
}

export async function exportFullVastData(mainWindow: BrowserWindow): Promise<MigrationReport> {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export all Vast data',
    defaultPath: `Vast-backup-${timestampSlug().slice(0, 10)}.vastbackup`,
    filters: [{ name: 'Vast Backup', extensions: ['vastbackup'] }]
  })
  if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled.' }
  const report = await createVastBackupArchive({
    dataRoot: vastDataPath(),
    destinationPath: result.filePath,
    appVersion: releaseAppVersion(),
    appId: 'app.vast.browser',
    platform: process.platform
  })
  return {
    ok: true,
    path: report.path,
    includedSections: report.manifest.includedSections,
    includedFileCount: report.includedFileCount,
    skippedFileCount: report.skippedFileCount,
    skippedFiles: report.skippedFiles,
    skippedFileDetails: report.skippedFileDetails,
    vastDataIncluded: report.vastDataIncluded,
    passwordVaultIncluded: report.passwordVaultIncluded,
    warnings: report.manifest.warnings
  }
}

export async function importFullVastData(mainWindow: BrowserWindow): Promise<MigrationReport> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Vast data',
    properties: ['openFile'],
    filters: [{ name: 'Vast Backup', extensions: ['vastbackup'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Import cancelled.' }

  const confirmed = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Import Vast data',
    message: 'Import this Vast backup and restart?',
    detail: 'Vast will back up the current profile first, extract the backup into a new data directory, and restart into it. Current data is not deleted.',
    buttons: ['Import and restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  if (confirmed.response !== 0) return { ok: false, error: 'Import cancelled.' }

  const backupPath = await createMigrationBackup('pre-import')
  const importRoot = join(stableDataPathConfigRoot(), 'imports', `import-${timestampSlug()}`)
  await mkdir(importRoot, { recursive: true })
  const extracted = await extractVastBackupArchive(result.filePaths[0], importRoot)
  const importedDataPath = join(importRoot, 'data')
  await writeConfiguredDataRoot(stableDataPathConfigRoot(), importedDataPath)
  setTimeout(relaunchWithNewDataPath, 250)
  return {
    ok: true,
    path: result.filePaths[0],
    dataPath: importedDataPath,
    backupPath,
    importedSections: extracted.manifest.includedSections,
    warnings: extracted.manifest.warnings,
    restartRequired: true
  }
}
