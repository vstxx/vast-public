# Vast Browser 0.2.7 release readiness

Current status: **NOT READY**

Evidence review: **2026-09-01**

This is the authoritative current decision. Historical readiness documents remain
useful evidence, but they do not authorize a 0.2.7 release. Do not publish a
direct release or submit a Store package while any required gate is BLOCKED,
FAIL, MANUAL ACTION REQUIRED, or NOT RUN.

## Versions and verified development artifact

- Vast semantic version: `0.2.7`
- Microsoft Store package version mapping: `1.2.8.0`
- Electron: `44.1.0`
- Chromium: `152.0.7977.65`
- Node: `24.19.0`
- V8: `15.2.124.18-electron.0`
- Actual public upgrade baseline: unsigned beta `v0.2.5`, repaired public
  snapshot `0c2c80b3718f45668a84af429a41387cf7f8e59b`
- Superseded Electron 44.1.0 development MSIX inspected on 2026-09-01:
  `Vast-0.2.7-Store-x64-Development.msix`, 470,274,654 bytes, SHA-256
  `184bd0fefc77d98a242e9e23677203b323b49e4833b2215346193fa3b19e2e03`,
  1,817 unpacked files. This is a development validation artifact, not a
  production or submission artifact. Its `1.2.7.0` package identity is also
  superseded because that full name was consumed by the rejected submission;
  the corrected candidate uses `1.2.8.0`.

## Release gate matrix

| Gate | Status | Exact evidence or blocker |
| --- | --- | --- |
| Version consistency | PASS | `npm run release:version-check` passed for package and lockfile version 0.2.7. |
| Electron/Chromium Store compliance | PASS | The installed Electron 44.1.0 executable reported the exact tuple above. This patch contains Electron fix #53198 for GPU-process termination when an AppX/MSIX application falls back to SwiftShader. `scripts/store-browser-policy.json` records Chrome Stable 152.0.7977.64, review date 2026-08-29 and a 60-day expiry without live scraping during normal builds. |
| Application build | PASS | Electron 44.1.0 application build, unpacked x64 runtime and development MSIX completed. |
| TypeScript | PASS | Typecheck passed after the Electron 44 clipboard migration. |
| Lint | PASS | `npm run lint` passed. |
| Unit/integration tests | PASS | `npm test` passed 583/583 with the Electron 44.1.0 dependency graph. |
| Release source audit | PASS | `npm run release:audit` passed after the Store implementation. |
| Electron E2E | NOT RUN | Not rerun against an installed final package. |
| Extensions E2E | NOT RUN | Not rerun against an installed final package. |
| Native extensions E2E | NOT RUN | Not rerun against an installed final package. |
| Relay tests | PASS | Relay unit/integration suite passed 31/31; live target verification remains separate and blocked below. |
| Relay staging live verification | BLOCKED | Cloudflare Access now admits the configured service token (`/health` returned HTTP 200 on 2026-08-30). The source-bound staging deployment/marker still requires the exact clean final SHA; see `RELEASE_0.2.6_PREREQUISITES.md`. |
| Relay production config/write verification | BLOCKED | Production synthetic D1 write gate requires the exact clean final SHA after fresh staging verification. |
| Extensions Hub tests | PASS | Hub TypeScript check passed and Hub tests passed 15/15; live deployment verification is recorded separately. |
| Extensions Hub staging verification | PASS | Isolated staging signer proof, health and catalog passed after signer-first deployment with key `vast-hub-staging-2026-02`. |
| Extensions Hub production readiness | PASS | Live health, catalog, signer proof and existing descriptor verification passed with current key `vast-hub-2026-02` and legacy descriptor key `vast-hub-2026-01`. |
| Avidae security/runtime | NOT RUN | No expensive runtime rebuild or final installed-package media pass was run. Existing runtime was packaged without changing its security boundary. |
| FFmpeg legal/provenance | NOT RUN | FFmpeg was deliberately not rebuilt; the Store workflow restores the existing verified cache and retains the release gate. |
| Electron fuses | PASS | The real Electron 44 `Vast.exe` was hardened and the fuse wire was read back successfully during packaging. |
| Direct installer | NOT RUN | No final NSIS 0.2.7 artifact exists. The authorized direct route is explicitly unsigned and must verify `NotSigned`, hashes and provenance. |
| Portable | NOT RUN | No final 0.2.7 portable artifact exists. Portable profile selection is source-tested and independent from Store metadata. |
| Direct updater | NOT RUN | No final unsigned 0.2.7 updater artifact exists; direct updater policy remains enabled only for direct release metadata. |
| Direct previous-version upgrade | NOT RUN | The actual public baseline is v0.2.5, but the packaged upgrade E2E awaits final artifacts. |
| Native x64 MSIX build | PASS | Windows SDK MakeAppx produced and unpacked the Electron 44.1.0 development package listed above; fuses, manifest, assets, ASAR metadata and the recursive 100-PE inventory passed. Production build still requires the exact final SHA and remaining live gates. |
| Partner Center certification | FAIL | The Electron 44.0.0 MSIX crashed at launch with Application Error 1000, `STATUS_BREAKPOINT` (`0x80000003`) at `logging::LogMessage::HandleFatal`; report ID `8115f3f9-6599-4aac-94e9-94a5c41d20c7`. Do not resubmit that artifact. Electron 44.1.0 and a GPU-enabled installed-MSIX launch check must pass before resubmission. |
| MSIX manifest validation | PASS | Actual package identity/version/x64/full-trust model, `vast`/HTTP/HTTPS protocols, minimal capabilities and assets were verified after unpacking. |
| MSIX local installation | MANUAL ACTION REQUIRED | The current shell is not elevated. Modern Windows rejects executable activation from unsigned packages, so the E2E now creates a one-day local test certificate, trusts it only in `LocalMachine\TrustedPeople`, signs temporary fixtures, and removes it in `finally`. Run on the elevated isolated Windows CI runner. |
| MSIX update simulation | MANUAL ACTION REQUIRED | The rejected `1.2.7.0` to corrected `1.2.8.0` harness tests 15-second GPU-enabled launch health, renderer creation and Event ID 1000 after both installs, but its elevated installed-package run remains required. |
| EXE to MSIX profile migration | NOT RUN | Both installed channels intentionally resolve to `%APPDATA%\Vast`; actual cross-channel preservation is not yet proven on an isolated profile. |
| MSIX to EXE profile migration | NOT RUN | Same shared-profile policy; actual reverse transition is not yet proven. |
| safeStorage/password-vault preservation | NOT RUN | Path continuity is implemented, but decryptability must be proven with synthetic credentials on the same isolated Windows user. |
| Cross-channel collision/single-instance behavior | NOT RUN | Requires installed direct and Store candidates on an isolated Windows environment. |
| Default browser/protocol behavior | NOT RUN | Store manifest registration and source policy are implemented; installed HTTP/HTTPS/vast/default-app behavior is not yet proven. |
| Uninstall/reinstall | NOT RUN | Store and direct cleanup/preservation behavior must be exercised on isolated profiles. |
| WACK | BLOCKED | WACK is installed at `C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe`, but the current shell is not elevated. No report was produced and no PASS is claimed. |
| Store policy review | PASS | Official Microsoft Store policy, MSIX packaging/signing, packaged desktop, WACK and default-app guidance reviewed 2026-08-29. |
| Store identity | PASS | Partner Center supplied exact values and the protected GitHub environment now contains `VAST_MSIX_IDENTITY_NAME`, `VAST_MSIX_PUBLISHER` and `VAST_MSIX_PUBLISHER_DISPLAY_NAME`. |
| Store signing model | PASS | The Store route intentionally builds an unsigned MSIX submission and Partner Center signs the accepted package after certification. No separate Vast certificate is required for this MSIX route. The verifier still inventories every real PE recursively by PE header and records its status as security evidence. |
| Store assets | PASS | All five generated PNGs were decoded from the actual MSIX and exact dimensions validated. |
| Store privacy/support URLs | PASS | Existing `https://vastbrowser.com/privacy` and `https://vastbrowser.com/support` remain the factual listing URLs; no contact address was invented. |
| Secret scan | NOT RUN | Current-tree and full-history scans must run from the exact final clean SHA; the actual MSIX verifier rejected common secret/private-key file types. |
| Artifact hash verification | PASS | Development MSIX SHA-256 and unpacked content report are recorded above. |
| Store updater disabled | PASS | Actual packaged ASAR metadata says `distributionChannel=microsoft-store` and `updateEnabled=false`; updater payload/manifests were absent. |
| Production endpoints | BLOCKED | Development artifact intentionally uses staging Relay. Only a production identity/final-SHA package can prove production Relay and Hub exclusively. |
| Package size | NOT RUN | Development size is recorded; production distribution-size budget has not run. |
| Final artifact re-download | NOT APPLICABLE | No 0.2.7 artifact has been published. |
| Windows 11 clean standard-user matrix | NOT RUN | Requires isolated VM/account. |
| Windows 10 matrix | NOT RUN | No suitable isolated environment was used. |

## Implemented channel boundaries

- `direct` and `microsoft-store` are authoritative build metadata values and
  are available only in local diagnostics; the distribution channel is not
  added to Relay telemetry.
- Direct builds retain the signed Vast updater. Store builds cannot enable it
  and report `Updates are managed by Microsoft Store.`
- Installed direct and Store builds select `%APPDATA%\Vast`; portable builds
  select `Vast Data` beside the portable executable.
- Store builds do not write unpackaged browser-registration registry entries or
  silently set defaults. The MSIX manifest owns protocol declarations and Vast
  opens the supported Windows Default Apps UI for user choice.
- The production Store build fails before expensive runtime work when Partner
  Center identity, final SHA, production Relay settings, policy freshness or
  production Hub readiness is missing.

## Checks executed in this working tree

| Command | Result |
| --- | --- |
| `npm run test:store` | PASS - 7/7 focused Store policy/manifest/version/signing and GPU-path launch-gate tests |
| `npm run test:electron-version` | PASS - exact Electron/Chromium/Node/V8 tuple |
| `npm run release:version-check` | PASS |
| `npm run release:audit` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS - 583/583 |
| `npm run test:app` | PASS - 66/66 Electron application checks |
| `tests/store/packaged-launch-health.test.ps1` | PASS - unpacked Electron 44.1.0 runtime stayed healthy for 20 seconds with normal GPU initialization, four owned processes and no Application Error 1000 |
| `npm run test:package:ci` | PASS - unpacked package resources and fuses verified |
| `npm run dist:store:dev` | PASS - Electron 44.1.0 development MSIX produced and verified; exact artifact evidence is listed above |
| elevated `tests/store/store-msix-upgrade.test.ps1` | BLOCKED locally - this shell is not elevated; the workflow runner must execute the machine-trusted ephemeral-certificate install/launch/upgrade/uninstall test |
| `npm audit --audit-level=high` | PASS - 0 vulnerabilities after lockfile-only patched transitive updates |
| `npm run test:app -- --pdf-only` | PASS - authenticated cookie/Referer/UA PDF fetched exactly once, MIME-routed and rendered through scoped ranges |
| `npm run audit:ci` | PASS - 0 client and 0 Relay vulnerabilities |
| `npm test --prefix relay` | PASS - 31/31 |
| `npm run hub:typecheck` | PASS |
| `npm run hub:test` | PASS - 15/15 |
| `npm run test:fuses:integration` | PASS - hardened real Electron 44 executable |
| `node scripts/verify-store-msix.cjs ... --development` | PASS - actual unpacked development package |
| `npm run dist:store:dev` | MakeAppx PASS; wrapper then failed on an absolute-path resolution bug. The bug is fixed and the produced package passed the standalone verifier; a redundant 470 MB rebuild was not repeated. |
| `npm run store:wack -- ...` | BLOCKED - WACK requires an elevated shell |
| `git diff --check` | PASS |

## External production blockers

- `RELEASE_0.2.6_PREREQUISITES.md` remains OPEN for Relay staging/final-SHA
  proof, rollout of a Vast build trusting the rotated production key,
  and final workflow evidence. The encrypted external key backup is confirmed;
  signer/Hub deployment, observability, obsolete public-Hub secret removal and
  live Hub readiness are complete.
- The protected public-release environment has the Cloudflare, release and
  Partner Center identity inputs. The current direct route is explicitly
  unsigned. Partner Center signs the accepted Store MSIX; a trusted
  Authenticode certificate is needed only if a future direct release is changed
  back to the signed route.
- Partner Center package history must confirm that `1.2.8.0` is monotonic; the
  Store-reserved fourth component remains zero.
- WACK and the install/upgrade/profile/vault/default-browser/uninstall matrix
  must pass on isolated Windows 11 x64; Windows 10 remains an additional manual
  compatibility target where available.
- The website must continue describing the currently downloadable v0.2.5 as
  unsigned until a new signed artifact is actually the current download.

## Final evidence required

Record the exact clean source SHA, direct and Store workflow run URLs/results,
all final artifact hashes, recursive PE inventory for the unpacked production
MSIX, clean uninstall results, production MSIX identity, WACK report,
isolated upgrade/profile/vault evidence, fresh Chromium recency report,
production Relay/Hub/signer/D1 proof, secret scans and Partner Center ingestion
result.

Until all required rows are PASS or explicitly NOT APPLICABLE: **Do not publish.**
