# Vast Browser 0.2.5 Beta release readiness

Audit date: 2026-08-25
Baseline revision: `654afb8a67a0723a6e82236b49aeb27a905ea96b`
Previous public release: `public-release-0.1.5` (2026-08-18)
Candidate version: `0.2.5`
Final verdict: **READY FOR THE FINAL BUILD AND CURRENT-ARTIFACT UPGRADE RETEST; NOT YET AUTHORIZED FOR PUBLICATION**

This report records the release-candidate preparation and isolated Hub staging
verification. It is not a publication authorization. No production deployment
or GitHub release is claimed by this report.

## Release gates

| Gate | Status | Evidence and required resolution |
| --- | --- | --- |
| FFmpeg corresponding source | **PASS** | Vast builds FFmpeg 9.0.1 from pinned source and MSYS2 inputs. The GPLv3 runtime, all linked codec sources, signed source packages and package recipes for statically linked GCC/MinGW runtime code, build recipes/configuration, license texts and exact provenance are bound to `ffmpeg-corresponding-source-win64.tar.zst`. Local and release gates verify the actual binary hashes, inner and outer source hashes, PE imports and Avidae operations; workflows upload source and provenance beside every binary asset. |
| Verified legal operator and contact | **PASS** | Production configuration sets `HUB_LEGAL_OPERATOR_NAME="Jan Nowacki"` and `HUB_LEGAL_CONTACT_URL="https://vastbrowser.com/legal"`. Validation rejects missing, placeholder, insecure or localhost production values; privileged publishing fails closed while the public catalog remains available. No company, registration, address, phone or email data was invented. |
| Live Extensions Hub staging edge | **PASS** | The isolated `extensions-staging.vastbrowser.com` Worker uses separate staging D1 and R2 resources and has no scheduled trigger. The read-only verifier passed on 2026-08-25 at `09:29:44Z`, checking the catalog and all legal pages plus HSTS, CSP, nosniff, referrer, permissions and frame headers. No production data was read or mutated. |
| Immutable 0.1.5 → current QA artifact upgrade | **MANUAL RETEST REQUIRED** | The harness previously passed against an earlier 0.2.5 candidate. Its rerun downloaded and hash-verified the immutable 0.1.5 installer, but Windows canceled `Start-Process` before the freshly built local updater launched. No failed migration occurred and the isolated temporary tree was cleaned; the exact final QA artifact still needs one interactive rerun. |
| Authenticode availability | **BLOCKED FOR SIGNED RELEASE** | No Windows code-signing certificate or signing environment is configured. The separate public unsigned-beta path remains available only after the release owner explicitly records the exact risk acknowledgement required by the release workflow. |

The FFmpeg, Hub legal configuration and isolated staging-edge gates are resolved.
Public release authorization still requires the final-artifact upgrade pass and
either Authenticode signing or the explicit unsigned-beta risk acknowledgement.

## Release identity and runtime

| Check | Status | Evidence |
| --- | --- | --- |
| Version declarations | PASS | `package.json`, lockfile, workflows, updater config, artifact templates, and metadata source use `0.2.5`; `npm run release:version-check` enforces this centrally. |
| Previous public version | PASS | Release inputs use `0.1.5`; historical fixtures and the live website download manifest remain factual rather than advertising nonexistent 0.2.5 assets. |
| Electron runtime | PASS | Electron is pinned exactly to `43.4.1`; the executable reports Chromium `150.0.7871.224`, Node `24.18.1`, and V8 `15.0.245.28-electron.0`. `npm run test:electron-version` checks the installed executable. |
| Electron fuses | PASS | The actual Electron 43 executable passed fuse application/readback integration with RunAsNode, Node options/inspect disabled and ASAR integrity/ASAR-only loading enabled. |
| Public beta configuration | PASS | Workflows explicitly set beta channel, Relay enabled against production, and previous version `0.1.5`. Release metadata includes Relay enabled/environment/endpoint/key ID and rejects any public build pointed at staging. |
| IDU+ packaging boundary | PASS | IDU+ remains separate publisher tooling/source. Package verification scans unpacked resources, source inside ASAR, installer, portable executable, updater, update ZIP, nested archives, manifests, `.vext` files, IDU+ media/fonts, and Cat assets whenever metadata marks Cat excluded, including private QA candidates. |

## Extensions Hub

| Check | Status | Evidence |
| --- | --- | --- |
| Match patterns | PASS | Desktop and Hub use one strict Chrome match-pattern parser instead of prefix regular expressions. Invalid schemes, ports, credentials, hosts, paths, and wildcard forms are rejected. |
| Windows archive paths | PASS | `.vext` validation rejects traversal, absolute/drive paths, control characters, Windows-forbidden characters, reserved device names, case collisions, links, encryption, unsupported compression, and ZIP-bomb conditions. |
| Dynamic code policy | PASS | JavaScript is parsed with Acorn and walked as an AST. `eval`, Function constructors, string timers, remote imports/scripts/workers, and WebAssembly are blocked. Minification, obfuscation, and encoded-source heuristics require manual review. Parse failures block release validation. |
| Download counters | PASS | A successful `GET` increments the counter; `HEAD`, errors, and missing objects are read-only. |
| Media pipeline | PASS | Cloudflare Images decodes uploads, enforces byte, dimension and pixel-count limits, scales to catalog bounds, and re-encodes canonical WebP before R2 storage so source EXIF/GPS/XMP is not retained. |
| Edge security | PASS | Tests and the isolated live staging edge verify HSTS, CSP, nosniff, referrer policy, permissions policy, frame protections, secure session/CSRF cookies, origin validation, and bounded request bodies. |
| Publisher terms | PASS in code | Acceptance records version, text hash, and timestamp. Listing creation, package/media upload and submission fail closed without current acceptance and verified legal configuration. Submit also requires a fresh warranty confirmation. |
| Data practices | PASS | Listings declare local-only or external processing, describe remote services, and require an HTTPS privacy-policy URL for transmission/external processing. |
| Extension reports | PASS | Public reports are categorized, bounded, rate-limited, and never auto-delist. Reviewer decisions, reasons, publisher-notification confirmation, and legal-hold state are stored with audit actions. |

## Privacy and security

| Check | Status | Evidence |
| --- | --- | --- |
| Product privacy copy | PASS | Documentation consistently states “Vast collects no browsing telemetry” while separately describing Browser, Relay, Hub, and independent publisher-extension data contexts. |
| Relay instance safety | PASS | `instance_kind` is an explicit `packaged`, `development`, `test`, or `unknown` value. Cleanup of test records is allowed only when `instance_kind='test'`; no inference from names, age, version, or activity is permitted. |
| Hub data and retention | PASS | Notices describe GitHub OAuth/profile data, sessions/CSRF, keyed IP hashes for rate limiting, D1/R2 objects, packages/media, review/audit, terms, and reports, with bounded cleanup and legal-hold exceptions. |
| CSV export | PASS | Password and Avidae CSV exporters neutralize every textual cell beginning with `=`, `+`, `-`, or `@` before RFC-style quoting. |
| Packaged CSP | PASS | Packaged app chrome uses `connect-src 'self'`; privileged network operations remain brokered through main. Development loopback allowances and the Avidae loopback frame are separate. |
| Avidae boundary | PASS | Tests cover mutating and Socket.IO authorization, public-IP pinning across redirects to resist DNS rebinding, IPv4/IPv6 private and metadata ranges, token redaction, stale-process cleanup, and descendant termination. |
| FFmpeg distribution | PASS | The old Gyan path is absent from production automation. New FFmpeg and FFprobe hashes, full build configuration, license mode, system DLL imports and corresponding-source hash are recorded in generated provenance and rechecked against packaged/downloaded artifacts. |

## Verification record

The final local verification run recorded these results. A PASS here is technical
evidence only and does not override the publication blockers above.

| Command / activity | Status |
| --- | --- |
| `npm run release:version-check` | PASS |
| `npm run test:electron-version` | PASS |
| `npm run test:fuses:integration` | PASS |
| `python -m unittest tests/avidae/avidae_security_test.py` | PASS (8 tests) |
| Gyan baseline versus Vast FFmpeg capability suite | PASS (18/18 real operations on both; no functionality loss) |
| `npm run ffmpeg:release:check` | PASS (FFmpeg 9.0.1 GPLv3, provenance, licenses, source archive, PE imports and capabilities) |
| `npm run avidae:runtime:prepare -- --resume` and runtime self-test | PASS (new FFmpeg, FFprobe, Chromium, screenshot and video recording) |
| `npm run lint` | PASS |
| `npm test` | PASS (555 tests) |
| `npm run audit:ci` | PASS (0 vulnerabilities in desktop/root and Relay lockfiles) |
| `npm run hub:typecheck` | PASS |
| `npm run hub:test` | PASS (14 tests) |
| `npm run hub:build` | PASS (explicit production-config dry run; D1, R2, Assets and Images bindings resolved) |
| Isolated Hub staging deploy and read-only edge verification | PASS (`extensions-staging.vastbrowser.com`; no production mutation) |
| Relay `npm run check` | PASS (type generation/check, typecheck, panel build, 30 tests) |
| `vastsite` lint/test/build | PASS (9 tests; the public download manifest correctly remains 0.1.5 until verified 0.2.5 artifacts exist) |
| `vast-docs` test/build | PASS (41 source pages validated; 42 rendered pages and local links checked) |
| `npm run test:extensions:e2e` | PASS (Chrome runtime lifecycle, Hub Explore sync, disable/enable/reload, Incognito, restart and removal) |
| `npm run test:extensions:native-e2e` | PASS (native sandbox, authenticated API, contributions, disable and uninstall cleanup) |
| Electron E2E Relay isolation | PASS (both extension E2Es build with Relay disabled and the internal offline harness enabled) |
| `npm run test:updater` | PASS |
| `npm run test:upgrade:0.1.5` | PREVIOUS PASS; CURRENT-ARTIFACT RETEST REQUIRED (Windows canceled updater launch before migration) |
| `npm run test:app` | PASS (63 checks in development) |
| Packaged app smoke | PASS (63 checks against a Relay-disabled private package; public W3C PDF fixture) |
| Final beta Cat-off startup | PASS (final packaged runtime remained healthy for 12 seconds with the staging Relay host DNS-blocked; no remote check-in) |
| `npm run dist:upgrader` pipeline (private unsigned QA) | PASS (installer, portable, updater and full update ZIP; no publication) |
| `node scripts/verify-release-package.cjs` | PASS (actual packaged FFmpeg/FFprobe, source bundle, ASAR, update ZIP, fuses, Relay metadata and excluded assets) |
| Distribution budgets | PASS (installer 304.62 MiB; portable 258.11 MiB; update ZIP 427.65 MiB; unpacked runtime 1011.53 MiB) |
| `npm run test:package:ci` | PASS (prepared-release and CI staging layouts supported) |
| `git diff --check` in all three repositories | PASS |
| Live staging edge | PASS (isolated read-only verification) |
| Full-history secret scan | NOT RUN locally (the pinned CI gate is configured) |

## Upgrade and package checks

The Windows upgrade harness downloads the immutable unsigned 0.1.5 installer,
requires SHA-256 `a82c0a9cfea5564894db3b9bb3eedf9ce976d811bcfeb7c8680c9f6f6408b06a`,
requires Authenticode `NotSigned`, installs to an isolated location, creates
profile sentinels and Relay identity, upgrades to the local 0.2.5 candidate, and
verifies byte-for-byte preservation before cleanup. It must not run against a
normal user installation or profile.

The final package verifier checks installer, portable, updater, full-update ZIP,
nested application archives, unpacked resources, ASAR contents, manifests,
hashes, source commit, update repository, Relay metadata, signature policy,
Electron fuses, obfuscation evidence, excluded Cat/IDU+ resources, and secret
markers. Building a local artifact does not authorize publishing it.

Pre-final private QA artifact SHA-256 values (stale after the final UI changes;
these artifacts must not be published):

| Artifact | SHA-256 |
| --- | --- |
| `Vast-Setup-0.2.5.exe` | `5da8ff5da7d20061357afb52389150632fe6c56b021d1592ca23545cfb1233e3` |
| `Vast-0.2.5-Portable.exe` | `424296249be18d0d8932e15cb3664bbdee779d374eeb50e6f1dc16aa078df7be` |
| `VastUpdater-0.2.5.exe` | `dbf0dfb04c55fc5e19538d19af3414c230ceaa83bd7026f4f210fe0b94368077` |
| `Vast-0.2.5-update.zip` | `ddce72e487250cedba2bd9c968ac2a0354cb0a4b8ce20cb9e210004b94443016` |
| `ffmpeg.exe` | `a36bc89b407fe3d60b748e092758e6f6d187e508c127ec8d979cb5a9af721a32` |
| `ffprobe.exe` | `56d1d2d532a57ba101aa0ac3aa247f774012513ad35958f8f35af25ad27676f7` |
| `ffmpeg-corresponding-source-win64.tar.zst` | `4bb53b16fdeba098da8e50812c467b8a9083f5be663e52713052df35f6f1a859` |

## Final decision

**FFmpeg redistribution and Hub legal-operator task: PASS.**

The former corresponding-source, legal-operator and live staging-edge blockers
are resolved. Do not publish the stale QA artifacts listed above. A new final
build and its exact 0.1.5 upgrade retest are required; the chosen public release
path must then complete either the Authenticode gate or the explicit unsigned
beta authorization gate.
