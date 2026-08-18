# Storage Recovery

Vast stores browser data in Electron `userData/vast-data.json` through `src/main/storage.ts`.

## Backup Types

- `rolling`: created before normal storage writes.
- `manual`: created by the storage backup API.
- `invalid`: created when the active storage file is rejected during load.
- `pre-import`: created before replacing data from JSON import.
- `pre-restore`: created before restoring a backup.

Backups live under `userData/storage-backups`.

## API

The preload bridge exposes:

- `window.vast.storage.listBackups()`
- `window.vast.storage.createBackup()`
- `window.vast.storage.restoreBackup(id)`

Restore validates the selected backup with the same `PersistedData` checks used for normal load/import. It refuses invalid backup ids and path traversal.

## Operational Notes

Updater scripts must not overwrite Electron `userData`. Runtime replacement should touch application files only. If an update fails, the updater should roll back runtime files and leave `userData` untouched.
