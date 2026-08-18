# Open-source readiness

Audit date: 2026-08-18

Scope: the clean `vstxx/vast-public` source export. This report does not certify binaries previously published from the private development repository.

| Area | Status | Evidence |
| --- | --- | --- |
| License | PASS | Vast-owned source is under the root MIT License, copyright 2026 VastProductions. |
| Secrets in current tree | PASS | No private keys, certificate bundles, known token formats, plaintext credentials, or tracked secret environment files were found. |
| Full public Git history secret scan | PASS | The public branch is created as one root snapshot and contains no inherited private history. |
| Private email history | CLEANED | Private development history is not present in this export; the public root commit uses the configured GitHub noreply identity. |
| Local machine paths | PASS | No private Windows user-profile or internal absolute repository paths remain in tracked public files. |
| Generated artifacts | PASS | Tracked build, .NET `obj`, benchmark, screenshot, release archive, log, cache, and local test outputs were removed and ignored. |
| Third-party licenses | PASS | Notices are preserved for public source dependencies. The unlicensed Cat artwork is excluded rather than relicensed. |
| FFmpeg binary redistribution | BLOCKED | The release workflow does not yet publish and verify the complete corresponding GPL source set for the exact Gyan build; binary workflows fail closed. |
| Cloudflare Relay exposure | ACCEPTABLE | Public configuration contains deployable identifiers, not secrets. Private signing keys and deployment credentials remain secret-store values. |
| README/public docs | PASS | Public purpose, privacy, support, development, architecture, experimental status, security, contribution, licensing, and export boundaries are documented. |
| CONTRIBUTING | PASS | Practical setup, validation, sensitive-area, license, secret-safety, PR, and reporting guidance is present. |
| Security policy | PASS | Supported status and coordinated private reporting guidance are documented without inventing a contact address. |
| Build | PASS | `npm run build` completed from the clean public export; the real Electron fuse integration check also passed. |
| Tests | PASS | 469 public-source Node tests passed, with only 3 artwork-dependent Cat tests explicitly excluded; Relay passed 30 tests and both updater suites passed. |

## Overall

**PUBLIC SOURCE: READY FOR PUBLICATION**

**BINARY RELEASE/MIRROR: NOT READY.** Do not publish FFmpeg-containing installers from this repository until the complete corresponding-source delivery gate is implemented and reviewed. Existing 0.1.5 binaries from the private repository are deliberately not mirrored.

## Publication rules

1. Keep this repository independent from the private repository's history; do not merge or force-push the private commit graph into it.
2. Do not restore excluded Cat artwork without documented redistribution permission.
3. Do not remove the fail-closed FFmpeg gate merely to make a release workflow pass.
4. Build future releases from an immutable public commit, run all validation, preserve third-party notices, and attach exact provenance/checksums.
5. Keep signing certificates, GitHub tokens, Cloudflare credentials, Relay signing keys, and updater secrets only in GitHub Environments or provider secret stores.

## Validation record

- `npm ci` — 505 packages audited, 0 vulnerabilities.
- `npm run lint` — passed.
- `npm test` — 469 passed, 0 failed; 3 tests requiring the deliberately excluded Cat artwork were not selected.
- `npm run audit:ci` — root and Relay audits both reported 0 vulnerabilities.
- `npm run updater:stage` and `npm run release:audit` — passed.
- `npm run build` — passed.
- `npm ci --prefix relay` and `npm run check --prefix relay` — generated types current, typechecks/build passed, 30 tests passed.
- `npm run test:updater` — updater and bootstrapper suites passed.
- `npm run test:fuses:integration` — hardened fuses were applied to and re-read from a real Electron executable.
