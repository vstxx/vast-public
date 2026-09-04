# Vast Release Guide

Vast releases are built from the Electron/Vite output and packaged with `electron-builder`.

## Build Classes

- Private/dev build: local testing, unsigned or internally signed, updater disabled by default.
- Signed public beta/stable build: signed, timestamped, obfuscated, updater enabled, and targeted at the public release repository.
- Explicit public unsigned release: an exceptional beta/stable route requiring `VAST_PUBLIC_UNSIGNED_RELEASE=1`, the exact risk acknowledgement, immutable hashes/provenance, a visible `PUBLIC-UNSIGNED-RELEASE.md` warning, and production re-download verification. A stable run creates a normal GitHub Release; a beta run creates a prerelease.

## Commands

```bash
npm run lint
npm run test
npm run release:audit
npm run dist:private
```

Signed public beta and stable builds must set:

```bash
VAST_RELEASE_CHANNEL=stable
VAST_PRIVATE_BUILD=0
VAST_OBFUSCATE=1
VAST_UPDATE_ENABLED=1
VAST_RELEASE_REPO=vstxx/vast-public
VAST_PREVIOUS_VERSION=0.2.5
VAST_EXPECTED_SIGNER_SUBJECT=VastProductions
VAST_RELAY_ENABLED=1
VAST_RELAY_ENVIRONMENT=production
WIN_CSC_LINK=...
WIN_CSC_KEY_PASSWORD=...
```

The published `0.2.5` beta is the real unsigned public upgrade baseline. The
current `0.2.7` decision is tracked in `docs/RELEASE_0.2.7_READINESS.md`; the
exceptional unsigned route remains available only when explicitly authorized:

```dotenv
VAST_RELEASE_CHANNEL=stable
VAST_PRIVATE_BUILD=0
VAST_PUBLIC_UNSIGNED_RELEASE=1
VAST_UNSIGNED_RELEASE_ACK=I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK
VAST_PREVIOUS_VERSION=0.2.5
VAST_RELAY_ENABLED=1
VAST_RELAY_ENVIRONMENT=production
```

This configuration does not authorize publication. Vast's pinned FFmpeg must be
built and verified first; its provenance and complete corresponding-source
archive are mandatory release assets. The remaining manual staging/signature
gates are recorded in `docs/RELEASE_0.2.7_READINESS.md` and the one-time live
infrastructure prerequisites in `docs/RELEASE_0.2.6_PREREQUISITES.md`.

Prepare the self-contained Video & Audio runtime, then run:

```bash
python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt
npm run ffmpeg:build
npm run avidae:runtime:prepare
npm run release:local
```

This builds the single public Vast installer and updater/bootstrapper. The application has no edition, subscription, activation, or remote entitlement configuration.

`VAST_RELAY_ENABLED` and `VAST_RELAY_ENVIRONMENT` are independent compile-time
inputs. Public beta and stable builds require `production`; `staging` is only
for development and internal QA. Neither endpoint nor its pinned key can be
replaced by a runtime message or environment variable.

## Release Package

`scripts/prepare-release.ps1` organizes the generated artifacts under `release/` after the installer and single-file updater bootstrapper have been produced.

The icon hardening hook runs before electron-builder signs the app. In the signed direct route, the standalone updater is signed separately with the same certificate, and the final verifier rejects the package unless the installer, portable build, runtime, and updater all have valid timestamped Authenticode signatures from the expected publisher. The isolated unsigned direct route instead requires every top-level Vast executable artifact to report exactly `NotSigned` and publishes an explicit warning marker. The Store route is separate: Partner Center signs the accepted MSIX after certification, while Vast records a recursive PE inventory as package evidence.

The public workflow uploads a draft to `vstxx/vast-public`, downloads it back through the GitHub release API, verifies byte equality/signatures/timestamps, performs the signed previous-release upgrade test, publishes it, and downloads it once more through the public production URL. See `docs/SIGNED_RELEASE_TUTORIAL.md`.

Source and binary repositories are separate. The gate exports a sanitized public source snapshot, commits and tags it in `vstxx/vast-public`, and binds it to the exact clean `vstxx/vast` commit through `VAST_RELEASE_COMMIT`. The public tag's `package.json` and `.vast-source-provenance.json` must match the released version and source SHA before downloaded artifacts are accepted.

The release folder should include runtime files, installer files, updater files, docs, manifests, and checksums. Do not distribute staging artifacts from `release/win-unpacked` directly.

## Windows code signing

Code signing and JavaScript obfuscation are separate:

- Authenticode proves who published an executable and detects tampering.
- Selective JavaScript obfuscation raises the cost of reverse engineering but is not encryption and must never be used to hide secrets.

For a public release, obtain a publicly trusted Windows Authenticode certificate. A traditional OV certificate exported as a password-protected `.pfx` works with the current local pipeline. Keep the `.pfx` outside the repository and add only these local values to `.env.release.local`:

```dotenv
WIN_CSC_LINK=C:\secure\vast-code-signing.pfx
WIN_CSC_KEY_PASSWORD=<local-secret>
```

Then run:

```powershell
npm run release:check:local
npm run release:local
```

The signed public build fails closed when signing is missing. It signs the packaged runtime, NSIS installer, portable executable, and standalone updater with SHA-256 plus an RFC 3161 timestamp. `scripts/verify-release-package.cjs` rejects signed beta and stable packages unless every required signature reports `Valid`, contains a timestamp, and matches `VAST_EXPECTED_SIGNER_SUBJECT`.

The exceptional unsigned route is accepted only with `VAST_UNSIGNED_RELEASE_ACK=I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK`. It never claims publisher identity or a trusted timestamp. A release published through this route includes `PUBLIC-UNSIGNED-RELEASE.md`, embeds the exact source commit, publishes SHA-256/SHA-512 manifests, and is downloaded again from the production URL for byte-for-byte verification. Stable produces a normal GitHub Release and beta produces a prerelease. A published version/tag must never be reused for later signed binaries.

Never commit the `.pfx`, its password, `.env.release.local`, or cloud-signing credentials. A self-signed certificate is suitable only for a managed test environment where its root has been installed explicitly; it is not a public Vast release identity.

## Install Directory, Data Directory, And Migration

The Windows installer allows the user to choose the application install directory. User data is separate from app files and defaults to Electron `userData` (`%APPDATA%\Vast` on Windows).

Users can manage data from Settings -> Data:

- Export all Vast data creates a `.vastbackup` ZIP archive with a manifest, checksums, and migration warnings.
- Import Vast data validates a `.vastbackup`, backs up the current profile, extracts into a new data directory, writes the data-root config, and restarts Vast.
- Change Vast data directory validates the selected folder, backs up and copies current data, writes `%APPDATA%\Vast\data-root.json`, and restarts Vast.
- Open data folder opens the active data root.

See `docs/DATA_MIGRATION_AND_STORAGE.md` for exact included/excluded data and limitations around password vault portability and website sessions.
