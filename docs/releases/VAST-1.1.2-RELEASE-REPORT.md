# Vast 1.1.2 release report

Date: 2026-08-01
Target: Windows x64
Previous release: 1.1.1
Source version: 1.1.2

## Current release status

The Vast 1.1.2 source, NSIS installer, portable package, single-file updater,
downloadable update bundle, manifests, checksums, selective JavaScript obfuscation,
and release verification are complete.

The artifacts produced at this checkpoint are an **internal unsigned beta**, not a
public stable release. The machine has no configured Windows Authenticode certificate,
and the public stable release guard correctly rejects the build without `WIN_CSC_LINK`
and `WIN_CSC_KEY_PASSWORD`. These unsigned files must not be published as stable.

## Verified artifacts

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `Installer/Vast-Setup-1.1.2.exe` | 121,680,352 bytes | `841f39f8f0d53d912f39cfe5e63c4eaddc72bf819c92b8be078110258a8ba069` |
| `Installer/Vast-Setup-1.1.2.exe.blockmap` | 127,971 bytes | `49eb82bc2818886bff4e2ee7ac2e34bc6591c9a5d95a7cd2868fded7cee2c9cc` |
| `Installer/Vast-1.1.2-Portable.exe` | 107,717,862 bytes | `ccd7a72a994bfa5380238a24c8942a877d33ca636eeae24dace44a7cbb091d35` |
| `Updater/VastUpdater-1.1.2.exe` | 35,098,731 bytes | `0ae2d237e7e8b58419e2cb8cc9bae3f97682e83c786cb03771e6e573d9c78f10` |
| `Downloads/Vast-1.1.2-update.zip` | 174,253,896 bytes | `123b276af790df79996c05dfb3c396ba52bcf33f317cfd73217f9f532c815241` |
| `Downloads/update-manifest.json` | 761 bytes | `c8210a26025d0d4559697fdbcfa23784be5eae69728a64931723dad1e1e2d80f` |

These hashes describe the internal beta artifacts only. A signed stable rebuild will
produce different executable hashes and must regenerate every manifest and checksum.

## Included changes

- Added request-level ad, tracker, privacy, malware, and optional regional filtering,
  with local list updates, allowlists, user exceptions, and history-free statistics.
- Added tracking-parameter cleaning during navigation and clean-link copying, including
  removed-parameter previews and an optional affiliate-parameter policy.
- Added third-party cookie protection, site-data inspection and cleanup, forget-site
  controls, and isolated or temporary workspace identities.
- Added coherent fingerprinting-protection profiles and configurable WebRTC leak
  protection with compatibility exceptions.
- Added the New Tab-only bookmarks-bar mode and current-tab bookmark navigation.
- Refined the omnibox controls, Windows icon sizing, and vertical Vast wordmark.
- Reworked custom dropdown sizing, viewport positioning, scrollbar spacing, and concise
  single-line setting labels.

## Verification completed

- TypeScript/lint: passed.
- Unit and integration tests: 334/334 passed.
- Electron application smoke tests: 77/77 passed.
- Updater PowerShell tests: passed.
- Updater bootstrapper release tests: passed.
- Chromium-port tooling: 9 PowerShell files plus 2 Python tests passed.
- Release security audit: passed.
- Development and internal-beta release checks: passed.
- Production build and performance budget: passed.
- Final package structure, metadata, checksums, and update-bundle verification: passed.
- Selective obfuscation report: `startup-selective-v1`, 3 of 26 JavaScript bundles
  protected.
- Packaged metadata: beta channel, private build, updater enabled, obfuscation enabled,
  repository `vstxx/vast-releases`.
- Installer, portable executable, updater, and runtime correctly report `NotSigned` for
  this internal beta.

The full Chromium source tree was not rebuilt. Chromium-port preflight still reports
that the Visual Studio 2026 Desktop C++ workload with ATL/MFC is unavailable; the
complete port tooling suite itself passes.

## Updater readiness

The 1.1.2 updater targets 1.1.1 and uses one edition-neutral payload. The generated
manifest points to:

```text
https://github.com/vstxx/vast-releases/releases/download/v1.1.2/update-manifest.json
```

The endpoint has not been published. The local beta manifest and update bundle are
ready for controlled updater testing.

## Requirements before a public stable release

1. Configure a publicly trusted Windows Authenticode certificate and password.
2. Run `npm run release:check:local` and rebuild through `npm run release:local`.
3. Confirm timestamped `Valid` signatures for the runtime, installer, portable build,
   and standalone updater.
4. Re-run all package, updater, audit, and application tests.
5. Install and update in a clean Windows account, verifying profile preservation and
   rollback.
6. Only then create tag `v1.1.2` and publish the signed assets.
