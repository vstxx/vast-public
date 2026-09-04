# Vast Data Migration And Storage

This note documents the current 0.2.7 storage model, export/import behavior, and custom data directory support.

## Authoritative Data Root

Vast uses one authoritative user data root.

- Default installed direct and Microsoft Store root: `%APPDATA%\Vast`.
- Portable root: `Vast Data` beside the portable executable.
- Dev/test root: `VAST_TEST_USER_DATA_DIR`, `VAST_DEV_USER_DATA_DIR`, or `%APPDATA%\Vast Dev`.
- Custom root: stored in `%APPDATA%\Vast\data-root.json` as `customDataRoot` for
  installed builds, or in the portable `Vast Data` root for portable builds.

The custom root is read before the app is ready and applied with `app.setPath('userData', ...)`, so Chromium profile state and Vast-owned files stay under the selected directory. The renderer cannot write arbitrary paths directly; export, import, folder open, and data directory changes go through validated main-process IPC.

## Current Persistent Data

Vast-owned data under the data root includes:

- `vast-data.json`: workspaces, tabs, tab groups, bookmarks, history, downloads metadata, notes, reading list, site memory, macros, macro logs, session snapshots, recent commands, settings, Labs state, shortcuts, permissions, reader settings, spoofing settings, and UI preferences.
- `storage-backups/`: rolling/manual/pre-restore storage JSON backups.
- `password-vault.json`: OS-encrypted password vault records and readable metadata.
- `vast-network-devices.json`: remembered local Network Devices aliases, cache, and logs.
- `integrations.json`: optional local integration credentials/config if the user created it.
- `avidae/`: local Video & Audio data directory (legacy compatibility name).
- `Logs/`: diagnostic logs such as OAuth popup/spoofing logs.
- Chromium profile files/directories such as `Local State`, `Preferences`, `Local Storage`, `IndexedDB`, `Session Storage`, `Sessions`, `Service Worker`, cookies, and related browser state.

Updater scratch/log data lives under `%LOCALAPPDATA%\Vast\UpdaterDownloads` and `%LOCALAPPDATA%\Vast\UpdaterLogs`; it is not part of normal profile migration.

The current JSON schema is version 8. Migration begins with the current default shape and overlays the entire existing profile before validation, so new fields are additive. Existing workspaces, tabs, notes, bookmarks, macros, quick links, Labs choices, sidebar state, and startup-volume preference are retained. The clean single-workspace defaults apply only when no valid profile data exists.

## Full Export

Settings -> Data -> Export all Vast data writes a `.vastbackup` file. The archive is ZIP-formatted and contains:

- `manifest.json` with product, app id, format version, app version, platform, creation time, source data path, included/excluded sections, checksums, and warnings.
- `README.md` with human-readable migration notes.
- `data/` with exportable Vast profile files.

The export includes Vast JSON storage, backups, notes, tabs/session/workspaces, bookmarks, history, reading list, settings, Labs state, local feature data, the password vault file, and browser profile state where present.

New exports exclude the deprecated `license-cache.json` and `license-device.json` files. Older archives that declare those entries still receive full ZIP, checksum, and manifest verification during import, but the two files are intentionally not restored.

The export intentionally skips volatile caches and updater scratch data, including `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `ShaderCache`, `Crashpad`, `UpdaterDownloads`, `UpdaterLogs`, `Temp`, and `Tmp`.

## Full Import

Settings -> Data -> Import Vast data validates the `.vastbackup` manifest, creates a full pre-import `.vastbackup` of the current profile, extracts into a new data directory under `%APPDATA%\Vast\imports`, writes the custom data-root config, and restarts Vast into the imported profile.

The current profile is not deleted during import. This avoids overwriting locked Chromium files while the app is running and provides rollback by keeping the previous root plus the pre-import backup.

## Changing Data Directory

Settings -> Data -> Change Vast data directory:

- asks the user for a target directory,
- rejects unsafe targets such as filesystem roots, Windows system directories, Program Files, the app install directory, or folders inside the active data root,
- creates a full backup,
- copies the current data root while skipping volatile caches,
- writes `%APPDATA%\Vast\data-root.json`,
- restarts Vast.

The old data directory is left in place.

## Installer And Updater

The Windows NSIS installer allows the application install directory to be changed. User data remains separate from application files.

The updater detects the install directory separately from the user data root. It reads `%APPDATA%\Vast\data-root.json` and prioritizes the configured custom data root before default/legacy roots, then backs up critical user data before replacing app runtime files. It does not delete profile data.

Website session continuity is handled explicitly:

- Existing installs that used Electron's default session are migrated once into `Partitions/vast-default` before Chromium opens its databases.
- Missing stores such as cookies, local storage, IndexedDB, service workers, and workspace partitions are copied without overwriting stores already created in the target partition.
- If both old and new cookie stores contain data, missing cookies are merged through Electron's cookie API and current target cookies win.
- Before an in-app update restart, every known persistent session flushes DOM storage and its cookie store. An updater restart does not run the optional clear-on-exit privacy cleanup.
- Standalone updater backups treat both the default Chromium stores and `Partitions/` as critical profile data.

## Machine-Bound And Sensitive Data

- Password vault: encrypted with Electron `safeStorage`, which can be OS/account-bound. The backup includes the encrypted vault and matching Chromium encryption state where present, but passwords may not decrypt on another Windows account or computer. Use the Password Manager CSV export only when an explicit plaintext export is needed and store that file securely.
- Website sessions/cookies: Chromium profile state is included where present, but website login sessions are not guaranteed to transfer across computers or OS accounts.
- `integrations.json`: can contain local provider credentials. If present, keep backups private.

## Known 0.2.7 Limits

- Import currently uses the safe "import into a new data directory and restart" path. In-place replacement and merge modes are not exposed yet.
- A first-launch data directory wizard is not implemented in 0.2.7; users can choose the app install path in the installer and choose/migrate the data path in Settings.
- Password and website session portability depends on OS/browser encryption behavior and should not be presented as guaranteed.
