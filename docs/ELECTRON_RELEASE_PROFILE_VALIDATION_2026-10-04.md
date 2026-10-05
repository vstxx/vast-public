# Electron 44 release-profile validation (2026-10-04)

## Candidate and provenance

The private, unsigned Windows `--dir` package at `release/win-unpacked` was built from source commit `867460b39c9156231537fe337ccfc031f915a2a0` with the Electron 44.3.0 Vast r5 patchset and the release GN profile. The native build completed on 2026-10-04. `scripts/verify-electron-release-profile.cjs` checked the official release profile, `DCHECK` off, PGO phase 2, ThinLTO, V8 profile, and generated Blink compile flags.

The source `electron.exe` is 246,300,672 bytes, SHA-256 `b40c3bd45dfe47bafd77b96e3084692f0494dd4ff3ddb0eac4d7031a60c7b9d7`. `patches/extension-compatibility-runtime.json` pins those bytes. The release fingerprint bound that binary, the r5 patchset, the ECE 4.9.0 runtime and source commit before packaging.

`scripts/verify-private-runtime-package.cjs` verified the private package: its branded `Vast.exe` has the same native PE `.text` section as the pinned Electron binary; 12 native DLL/data/resource files are byte-identical; `app.asar` contains the matching release fingerprint and ECE runtime; the required Electron fuses are set. Packaged `Vast.exe` SHA-256 is `c979569695baa0abd2af8c3cbfa38e2ca659666a216673be510f5964d5d68c92`. Branding changes the overall EXE hash, so whole-file equality is not expected.

The private package is unsigned and is **not** a signed installer, MSIX, or public release. No real user profile, saved vault, or production update path was exercised.

## Runtime verification

- Packaged extensions E2E passed installation, restore, content scripts, storage, management controls, disable/enable/reload, Incognito, restart and removal.
- Packaged adblock E2E passed early safe and trusted document rules, fetch/XHR blocking, SPA cosmetics, site controls, OAuth exclusions, malformed/oversized/timeout fail-open, request/DOM stress, lifecycle and cache. The same run checked guest CSS `env()`/`var()`/Typed OM fallback and completed 20 popup close/reopen cycles.
- The direct native adblock fixture passed 25/25 early-rule stress runs and 8/8 full E2E runs after the fixture correction. Another 10 full runs with frame probing passed.
- Direct native CSS regression passed using `D:\VastElectron44\src\out\VastRelease\electron.exe`.
- Packaged launch health passed with an isolated absolute profile: 20 seconds, four Vast processes, zero Windows Application Error events, GPU not disabled. A 30-second repeat showed browser, GPU, utility and renderer processes with no `--disable-gpu` switch. This verifies process startup, not hardware acceleration throughput. The first invocation with a relative profile saw only one process; the health script now normalizes profile paths, and the relative-path rerun passed.
- `npm test`: 963 passed, zero failed, one skipped. `npm run test:release`: 44 passed. `npm run lint`, `npm run release:audit`, GPL compliance, Electron version, fuse integration, cookie encryption, and full-history Gitleaks scan passed.

## Adblock E2E failure explained

The test adds trusted fixture rules to a temporary unpacked `.vext`, but initially kept the bundled `assets/provenance.json` timestamp from 2026-09-14. With automatic list updates enabled, the October 4 test startup sometimes downloaded a fresh upstream uBlock list and replaced those fixture-only rules. In a failing run the engine was ready and the safe rule worked, while `ublock.updatedAt` changed to the test day and the trusted fixture rule disappeared. This was a fixture race, not evidence of a Vast rule-engine regression. The test now timestamps only its temporary provenance file, asserts that the fixture list remains in use, waits for a distinct document ID after reload and polls the blocked-request counter.

## Renderer diagnostics

`Invalid guestInstanceId` occurs on each tested popup `<webview>` detach. A minimal control reproduced it on both stock Electron 44.3.0 and the r5 release build, with and without preloads. All 20 popup cycles and clean exits completed. It is an upstream Electron teardown exception under this workload; process lifetime and long-session resource impact were **not** measured.

`sandboxed_renderer.bundle.js` sometimes reports `binding.startupData is null` in a short-lived isolated context. It also appeared in an earlier approved r5 run. The new direct adblock runs still passed functionally when it occurred. A stock Electron control with 20 launch/detach cycles did not reproduce it, so the exact trigger and impact remain unresolved. No native patch was made on an unproven hypothesis.

## CI cache and remaining release gates

The previous private CI cache pointed at the old Electron binary. `third_party/electron/electron-ci-cache.json` now names a separate tag derived from the new binary hash: `ci-cache-electron-b40c3bd45dfe47ba`. The new local archive is `.vast-build/electron-cache-candidate/electron-44.3.0-vast-r5-win32-x64.zip`, 158,098,598 bytes, SHA-256 `3d789805fdf1b48bc665634240921c0d85266763558f3a7c4c9663dfa9b78d89`. The repository restore script extracted and verified it end to end. **CI cannot use this candidate until the private release asset is uploaded under that new tag.** The old private cache remains untouched.

`npm run audit:ci` is red because of six high findings in the development dependency tree (`braces`, its dependents, and `http-cache-semantics`). Both direct advisories currently list no patched version: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp). `npm audit --omit=dev --audit-level=high` and the Relay audit each found zero vulnerabilities. The full audit gate was not waived or suppressed.

This is a verified private candidate, not a release clearance. The private CI cache upload, the full dependency audit, and the unresolved sandbox diagnostic remain open before claiming all release gates green.

## Release preparation follow-up (2026-10-04)

The pinned 158,098,598-byte archive was uploaded as a non-latest private release asset at `ci-cache-electron-b40c3bd45dfe47ba`. A fresh download matched SHA-256 `3d789805fdf1b48bc665634240921c0d85266763558f3a7c4c9663dfa9b78d89`; the release is no longer a draft. This resolves the CI cache availability blocker described above.

The development-only `http-cache-semantics` lockfile entry was updated to 4.3.0, removing that audit finding. The five remaining high findings share the unpatched `braces` dependency under Tailwind CSS 3.4.19. Production-only and Relay audits still pass. The full `audit:ci` gate remains red and must not be reported as passed.
