# Vast 1.1.1 release report

Date: 2026-07-31
Target: Windows x64
Previous release: 1.1.0
Source version: 1.1.1

## Current release status

The Vast 1.1.1 source, NSIS installer, portable package, single-file updater,
downloadable update bundle, checksums, selective JavaScript obfuscation, and release
verification are ready.

The artifacts built during this checkpoint are an **internal unsigned beta**, not a
public stable release. They must not be uploaded as stable because no trusted Windows
code-signing certificate or publication credentials are configured on this machine.
The public stable pipeline continues to fail closed when signing credentials are
unavailable. No commit, Git tag, GitHub release, or upload was created.

## Verified artifacts

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `Installer/Vast-Setup-1.1.1.exe` | 121,601,135 bytes | `0c5fd441f5b88b6d07bc0d7e23494d7f39adb9654b9aaa4679210b3d6a04a5d8` |
| `Installer/Vast-Setup-1.1.1.exe.blockmap` | 127,964 bytes | `54107e8ee0d39395a16685e5ec5213dc9778212227779991a451b571abfc8e38` |
| `Installer/Vast-1.1.1-Portable.exe` | 121,385,406 bytes | `45a527930dea231d7784d059c35e2f3400d237f6a5ad8d7df6cdc64acd862b19` |
| `Updater/VastUpdater-1.1.1.exe` | 35,098,726 bytes | `d89a3fb71ab02fc47565acc9322950d3642e3f6eda5cc6b2b6fbc9c633856e26` |
| `Downloads/Vast-1.1.1-update.zip` | 174,177,773 bytes | `f35c1c4b472c15a7644dba83493674cfa2fcc8568fe1a7702eb5ca88b43ca17f` |
| `Downloads/update-manifest.json` | 761 bytes | `4ce29d9e3a32f9492c96c4264e27f07358b7ae5ef5801062af4896130474cd02` |

These hashes describe the internal beta artifacts only. A signed stable rebuild will
have different executable and update-bundle hashes and must regenerate every checksum
and manifest.

## Included changes

- Vast is one product without Free/Pro/Team plans, activation, entitlements, product
  licensing, or a Supabase licensing backend.
- Vast Labs remains a local feature-flag system.
- The application and Windows executable use the new `vasticon.png` branding.
- The unfocused address is visually muted.
- HTML video players can enter native fullscreen and restore Vast chrome on exit.
- External application protocols require one explicit Open app or Block decision.
- Tabs with calls, active media, or capture sessions are protected from automatic
  unloading and background throttling.
- Legacy `edition` and `targetEdition` updater inputs are accepted only as ignored
  compatibility data and never select or reject a payload.

## Verification completed

- TypeScript/lint: passed.
- Unit and integration tests: 315/315 passed.
- Electron application smoke tests: 77/77 passed.
- Updater PowerShell tests: passed.
- Updater bootstrapper release tests: passed.
- Chromium-port tests: 9 PowerShell files plus 2 Python tests passed.
- Release security audit: passed.
- Development and internal-beta release checks: passed.
- Production build and performance budget: passed.
- Final package structure, metadata, checksums, and update-bundle verification: passed.
- Selective obfuscation report: present, strategy `startup-selective-v1`, 3 of 26
  JavaScript bundles protected.
- Packaged marker scan: no Supabase endpoint, `VAST_LICENSE`, `vast:license`, or
  removed product-backend code in packaged text files or `app.asar`.
- Authenticode inspection: correctly reported `NotSigned` for the installer, portable
  executable, updater, and packaged runtime in this internal beta.

The full Chromium source tree was not rebuilt. Its preflight fixture reports that the
Visual Studio 2026 Desktop C++ workload with ATL/MFC is not installed in the current
environment. This does not affect the Electron application package built here.

## Updater readiness

The 1.1.1 updater targets Vast 1.1.0 and uses one edition-neutral payload. Generated
`version.json`, `update-manifest.json`, and `release-manifest.json` contain no edition
or target-edition metadata. The intended public endpoint is:

```text
https://github.com/vstxx/vast-releases/releases/download/v1.1.1/update-manifest.json
```

The endpoint has not been published. Older updater inputs may still supply
`edition`/`targetEdition`; 1.1.1 deliberately ignores them for upgrade compatibility.

## Requirements before a public stable release

1. Configure a publicly trusted Windows Authenticode certificate and its password
   through the ignored local release environment.
2. Run `npm run release:check:local` and confirm the public stable guard passes.
3. Run `npm run release:local` to rebuild and timestamp-sign the runtime, installer,
   portable executable, and standalone updater.
4. Confirm all four Authenticode statuses are `Valid` and have RFC 3161 timestamps.
5. Re-run the updater tests, release audit, application smoke tests, and final package
   verifier.
6. Install into a clean Windows test account and verify launch, profile preservation,
   update discovery, installation, restart, and rollback.
7. Create tag `v1.1.1` only from the reviewed release commit and upload the newly
   generated signed artifacts using authorized publication credentials.
8. Download the published files and compare their SHA-256 hashes with the signed
   release manifest.
