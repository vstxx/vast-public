# Release Checklist

Use this checklist before publishing a Vast build.

## Required

- `npm run lint` passes.
- `npm run test` passes.
- `npm run release:audit` passes.
- `npm audit` reports zero known dependency vulnerabilities.
- `npm run test:fuses:integration` flips and verifies the profile on a disposable copy of the pinned Electron binary.
- `npm run release:check` passes for the selected signed release or explicitly acknowledged public unsigned beta environment.
- `npm run release:windows:0.1.5` is used for the public Windows release package.
- `node scripts/verify-release-package.cjs` passes after packaging.
- `npm run test:updater` verifies default-session and partition cookie data are migrated and backed up.
- Windows executable signing is enabled in `package.json`.
- The combined hardening hook runs through `build.afterPack`, applies the icon and Electron Fuses, reads the fuse wire back from the packaged binary, and completes before electron-builder signs the runtime.
- Packaged Fuse state has `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, and `EnableNodeCliInspectArguments` disabled, with `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled.
- Signed route: `Vast.exe`, installer, portable executable, and standalone updater all report Authenticode `Valid` and carry an RFC 3161 timestamp.
- Unsigned beta route: all four executables report exactly `NotSigned`; `PUBLIC-UNSIGNED-BETA.md` is present; `signaturePolicy` is `unsigned-public-beta`; the exact risk acknowledgement is set; the release is a prerelease.
- Signing secrets, when used, are present in CI env and never in git.
- `VAST_UPDATE_ENABLED=1` is set only for builds that should use the auto-updater.
- `VAST_OBFUSCATE=1` is set for every public beta/stable build.
- `VAST_RELEASE_COMMIT` equals the exact clean source `HEAD` and is present in packaged metadata, `version.json`, and both update/release manifests.
- `VAST_RELEASE_REPO=vstxx/vast-public` and `package.json` publish config points to `vstxx/vast-public`.
- One Vast installer and one updater payload are produced; manifests contain no edition or target-edition fields.
- `package.json` `build.protocols` registers only the custom `vast` scheme, never `http` or `https`.
- App chrome CSP is present and does not allow `unsafe-eval` or object embedding.
- The sensitive IPC policy exactly matches the AST-enumerated Password Manager, Network Devices, Video & Audio, and advanced-diagnostics handlers.
- Password Manager starts locked and its main-process session tests cover absolute timeout, vault inactivity, fresh unlock, screen lock, and suspend behavior.
- If Vast Notices is enabled, release metadata records a dedicated non-GitHub HTTPS origin and pinned Ed25519 key id. The feed tests reject active fields and signature tampering.
- `vast:browser:download-url` accepts only HTTP(S) URLs.
- PDF loading enforces the 100 MB byte limit and validates `%PDF`.
- `release/` is regenerated with the matching version script.
- `release/Installer/Vast-Setup-0.1.5.exe` exists.
- `release/Updater/VastUpdater-0.1.5.exe` exists.
- `release/Downloads/update-manifest.json` and `release/Downloads/Vast-0.1.5-update.zip` exist.
- Checksums are generated for distributed binaries and update packages.
- Public unsigned beta checksums include `PUBLIC-UNSIGNED-BETA.md`, and production downloads match the locally verified bytes.
- `out/obfuscation-report.json` is present and records protected main/password-manager bundles.
- NSIS allows changing the app install directory.
- Settings -> Data can export `.vastbackup`, import `.vastbackup`, open the data folder, and change the Vast data directory.
- The updater detects `%APPDATA%\Vast\data-root.json` and preserves a configured custom data directory.

## Manual QA

- Fresh install launches and shows the expected runtime version.
- Fresh install contains one workspace, one New Tab, no sample content, a closed sidebar/side panel, muted startup audio, and no visible Labs surface until optional features are enabled.
- Installer install-directory selection works on a disposable machine/profile.
- Change Vast data directory from Settings, restart, and verify `vast-data.json`, notes, bookmarks, password vault, and Chromium profile files are read from the new directory.
- Export `.vastbackup`, import it into a clean profile, and verify tabs/workspaces/bookmarks/notes/settings/Labs state match where technically portable.
- Update from the previous version preserves `userData`, cookies, sessions, bookmarks, notes, settings, and password vault files.
- Update from the previous version with a custom data directory preserves that directory.
- Storage backup list shows rolling/manual backups after normal saves.
- Restore from a storage backup succeeds on a disposable profile.
- Labs defaults are off on a fresh profile.
- Labs features require only the global Labs flag and their own local flag.
- Advanced Notes and Session Timeline work without Labs flags.
- Importing an older backup verifies but ignores deprecated product-entitlement metadata files.
- A legacy updater manifest with an edition marker is accepted and the marker is ignored.
- Auto-updater reports a clear disabled reason in private/dev builds.
- Auto-updater install fails unless the update state is `ready`.
