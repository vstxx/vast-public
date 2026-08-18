# Vast 1.1.0 release report

Date: 2026-07-26
Target: Windows x64
Previous release: 1.0.11
Source version: 1.1.0

## Current release status

The Vast 1.1.0 source, installer pipeline, portable package, single-file updater,
downloadable update bundle, checksums, selective JavaScript obfuscation, and release
verification are ready.

The artifacts built during this checkpoint are an **internal unsigned beta**, not a
public stable release. They must not be uploaded as stable because no trusted Windows
code-signing certificate is configured on this machine.

The public stable pipeline fails closed when signing credentials are unavailable:

```text
public stable build requires WIN_CSC_LINK or CSC_LINK
public stable build requires WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD
```

No GitHub release or public tag was created.

## Verified artifacts

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `Installer/Vast-Setup-1.1.0.exe` | 121,671,481 bytes | `a02970324f527e98b26a8e6f3e09ff63e6e11ea694252a9450c24d8e49f45491` |
| `Installer/Vast-Setup-1.1.0.exe.blockmap` | 128,988 bytes | `02557d656c8e8fb8295d9721499bab5d4b7a94060e018d9b38fc8563d530b456` |
| `Installer/Vast-1.1.0-Portable.exe` | 121,456,224 bytes | `dafa2c81d6e45fb76417300961a6958d426f13ac2d83ca90a36cdb3075777a19` |
| `Updater/VastUpdater-1.1.0.exe` | 35,098,747 bytes | `3be294af3bad7c48e852f03e2e765d502f2c9aa1c78f501d9abec07f61951e98` |
| `Downloads/Vast-1.1.0-update.zip` | 174,250,752 bytes | `057098f34ed73366c9ebefa633fa127820c7bfc4d76939bafcd0be414e27bfc3` |
| `Downloads/update-manifest.json` | 833 bytes | `afe9aaafa195b27bf44b78dbbdbe3cf5dd44fa67a5a14931a5d24eb2e69e97be` |

These hashes describe the internal beta artifacts only. A signed stable rebuild will
have different hashes and must regenerate every checksum and manifest.

## Verification completed

- TypeScript/lint: passed.
- Unit and integration tests: 338/338 passed.
- Electron application smoke tests: 75/75 passed.
- Updater PowerShell tests: passed.
- Updater bootstrapper release tests: passed.
- Public updater Free-only tests: passed.
- Release security audit: passed.
- Production build and performance budget: passed.
- Final package structure and metadata verification: passed.
- Selective obfuscation report: present, strategy `startup-selective-v1`,
  4 of 26 JavaScript bundles protected, including main-process startup code and the
  password-manager renderer.
- Authenticode inspection: correctly reported `NotSigned` for the installer, portable
  executable, updater, and packaged Vast runtime in the internal beta.

The release verification also covers the installer, blockmap, portable application,
update ZIP, update manifest, updater, checksum files, packaged build metadata,
obfuscation report, Authenticode status, signer certificate, and RFC 3161 timestamp.

## Updater readiness

The 1.1.0 updater is configured to upgrade Vast 1.0.11 to 1.1.0. Its dry-run mode was
fixed so it no longer creates transaction backups or modifies installation files.
Installer, runtime, update bundle, updater bootstrapper, manifests, and documentation
are consistently labelled 1.1.0.

The intended public update endpoint is:

```text
https://github.com/vstxx/vast-releases/releases/download/v1.1.0-free/update-manifest.json
```

It must remain unpublished until the stable signed artifacts pass the final verifier.

## Signing the public stable release

Use a publicly trusted Windows Authenticode organization-validation certificate that
can be exported or supplied as a PFX. A self-signed certificate is suitable only for
local testing and does not make a trustworthy public release.

Keep the certificate and password outside Git. Add these values only to the ignored
`.env.release.local` file:

```dotenv
WIN_CSC_LINK=C:\secure\vast-code-signing.pfx
WIN_CSC_KEY_PASSWORD=<local-secret>
```

Do not paste the PFX password into source files, shell history, issue trackers, release
notes, or chat.

Then run:

```powershell
npm run release:check:local
npm run release:local
```

The stable pipeline signs the Electron runtime, installer, portable executable, and
the separate updater. It uses SHA-256 and an RFC 3161 timestamp. The final verifier
rejects a stable build if any required executable lacks a valid signature, signer
certificate, or timestamp.

Before publication, independently verify:

```powershell
Get-AuthenticodeSignature .\release\Installer\Vast-Setup-1.1.0.exe
Get-AuthenticodeSignature .\release\Installer\Vast-1.1.0-Portable.exe
Get-AuthenticodeSignature .\release\Updater\VastUpdater-1.1.0.exe
Get-AuthenticodeSignature .\release\Vast-1.1.0\win-unpacked\Vast.exe
```

Every status must be `Valid`. Re-run all release tests after the signed rebuild and
use the newly generated hashes.

## Obfuscation boundary

Code signing establishes publisher identity and detects executable tampering.
Obfuscation only raises the effort required to read selected JavaScript. It is not
encryption and cannot safely hide credentials, API secrets, signing keys, or sensitive
user data. Such secrets must never be packaged into the application.

## Publication checklist after signing

1. Confirm the four Authenticode statuses are `Valid` and timestamped.
2. Re-run `npm run test:updater`, `npm run release:audit`, and the release verifier.
3. Confirm `version.json` and both update/release manifests say 1.1.0, stable, Free.
4. Confirm the clean 1.0.11-to-1.1.0 updater dry run and real upgrade test.
5. Install into a clean Windows test account and verify launch, profile preservation,
   Google login, update discovery, update installation, restart, and rollback.
6. Create tag `v1.1.0-free` only from the reviewed release commit.
7. Upload the signed installer, portable executable, blockmap, updater, update ZIP,
   manifests, checksum files, and release notes.
8. Download the published files again and compare their SHA-256 hashes.
