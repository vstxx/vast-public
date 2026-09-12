# Storage Recovery

Vast stores browser data in Electron `userData/vast-data.json` through `src/main/storage.ts`.

## Backup Types

- `rolling`: written at most once per minute before normal storage writes.
- `manual`: created by the main-process storage backup helper.
- `invalid`: created when the active storage file is rejected during load.
- `pre-import`: created before replacing data from JSON import.
- `pre-restore`: created before restoring a backup.

Backups live under `userData/storage-backups`. Rolling backups are trimmed to the 12 newest and manual backups to the 24 newest.

## Recovery behavior

Storage backups are a main-process recovery mechanism. When the active storage file is corrupt or fails schema validation, the storage module automatically restores the newest valid backup (skipping `invalid-*` files), preserves the rejected bytes as an `invalid-*` backup, and falls back to clean defaults only when no valid backup exists. Every restore re-validates the backup with the same `PersistedData` checks used for normal load/import, and backup ids/paths are strictly validated.

There is currently no renderer UI or IPC for listing, creating, or restoring individual storage backups (tracked on the roadmap). The user-facing backup surface is the full `.vastbackup` export/import in Settings -> Data; see [DATA_MIGRATION_AND_STORAGE.md](DATA_MIGRATION_AND_STORAGE.md).

## Operational Notes

Updater scripts must not overwrite Electron `userData`. Runtime replacement should touch application files only. If an update fails, the updater should roll back runtime files and leave `userData` untouched.
