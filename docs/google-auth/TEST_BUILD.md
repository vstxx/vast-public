# Internal Vast 1.0.11 final-polish test build

Built: 2026-07-17 (Europe/Warsaw)

This is an **unsigned, unpublished, directory-only** test build. It does not replace an installed Vast build, does not use the production profile by default and is not a public release.

## Artifact identity

- Base Git commit: `5a47c632fa78cd21fe1b85af2d57b9ce72997577`
- Executable: `<repo>\.vast-test-artifacts\final-polish-test-final-native\win-unpacked\Vast.exe`
- `Vast.exe` SHA-256: `fd78b51136cac8c8b560b6537c8165a2f6d3504d8bc23a17feab6a7dffb266fc`
- `resources/app.asar` SHA-256: `d2996ba6f0ed32bed71b5202009cec19acaf296cc47c4574cd1a9f70ee0547ef`
- Runtime: Electron 42.3.0 / Chromium 148.0.7778.180
- Architecture: Windows x64
- Production auth identity: `native-electron`

The worktree contains preserved mixed changes, so hashes identify the artifact instead of a false clean-commit claim.

## Packaging note

Normal release configuration still requires Windows executable editing/signing. This machine cannot extract two macOS symlinks from electron-builder's `winCodeSign` cache without the Windows “Create symbolic links” privilege. For this internal directory package, `win.signAndEditExecutable=false` was passed only on the command line. Public builds must still be signed.

## Launch

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\launch-google-auth-test.ps1
```

The launcher creates a timestamped profile below `%LOCALAPPDATA%\Vast\GoogleAuthTestProfiles`, refuses `%APPDATA%\Vast`, disables updates and prints the redacted log path.

## Verified

- Directory packaging and isolated-profile initialization: PASS.
- Updater disabled in launch check: PASS.
- Unit tests: 284/284 PASS.
- App smoke: 57/57 PASS.
- Updater suites and release audit: PASS.

This package is not evidence that Google accepts every account or third-party OAuth flow. See `TEST_MATRIX.md` and `FINAL_REPORT.md`.
