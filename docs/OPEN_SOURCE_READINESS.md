# Open-source readiness audit

Audit date: 2026-08-18
Audited revision: working tree based on `e37fbfa45ecffb6cf95eee61b660449bad7894a6`

This is the retained historical open-source audit from 2026-08-18. The current
0.2.5 release-candidate decision and verification evidence live in
`docs/RELEASE_0.2.5_READINESS.md`; where the records differ, that newer report
is authoritative.

This report is intentionally strict. A PASS means the checked condition is satisfied in the current working tree; it is not a warranty or legal opinion.

| Area | Status | Evidence / remaining action |
| --- | --- | --- |
| License | PASS | Vast-owned source can use MIT; see `LICENSE` and `docs/OPEN_SOURCE_LICENSE_AUDIT.md`. |
| Secrets in current tree | PASS | No tracked private key or credential was found. Three ignored local private-key files were removed and should be rotated conservatively. |
| Full Git history secret scan | NEEDS MANUAL CHECK | Manual filename, private-key-header and common token-prefix scans passed. `gitleaks` and `trufflehog` were unavailable, so an independent full-history scanner run remains required. |
| Private email history | PENDING HISTORY REWRITE | 70 commits contain `jas.nowacki@gmail.com` as author and/or committer email. The verified replacement and rewrite procedure are in `docs/GIT_HISTORY_PRIVACY_REWRITE.md`. |
| Local machine paths | FAIL | The current tracked tree contains zero occurrences of the audited private Windows user-profile path and no private absolute repository path, but 74 historical commits still contain it in 48 generated benchmark/.NET files. The authorized email-only rewrite must not change tree contents. |
| Generated artifacts | PASS | Tracked benchmark output, screenshots, release ZIP/checksums and .NET `obj`/generated constants were removed; `.gitignore` now covers their regeneration. |
| Third-party licenses | BLOCKED | The Cat Addon art archive has no established license, and release automation does not yet guarantee delivery of FFmpeg's exact corresponding GPL source. |
| Cloudflare Relay exposure | ACCEPTABLE | Worker names, domains, D1/R2/Access/rate-limit IDs and public key IDs are public deployment identifiers. Private signing material remains a Cloudflare Secret. |
| README/public docs | PASS | Root documentation now covers purpose, privacy, support, development, architecture, experimental features and project policies without stale version-specific build steps. |
| CONTRIBUTING | PASS | `CONTRIBUTING.md` contains the practical public contribution workflow. |
| Security policy | PASS | `SECURITY.md` documents supported versions and coordinated private reporting without inventing a contact address. Private vulnerability reporting still must be enabled and verified on GitHub. |
| Build | PASS | `npm run build` completed. The self-contained Video & Audio runtime integrity/license check and real Electron fuse integration check also passed. |
| Tests | PASS | 490/490 Node tests, 30/30 Relay tests, updater/bootstrapper tests and the final full `npm run test:app` with 63/63 app checks passed. An earlier app-smoke run hit one transient fullscreen timeout; both subsequent smoke executions passed completely. |
| Overall | NOT READY | The blockers below must be resolved before the repository becomes public. |

## Publication blockers

1. Establish and document a redistributable license/grant for `assets/cat-addon/Cat_85_Animations.zip` and its derived sprites, replace those assets with clearly licensed originals, or exclude that component from the public source distribution without changing the shipping product unintentionally.
2. Make every FFmpeg-containing binary release deliver the complete corresponding source set for the exact Gyan build (including covered linked components and build scripts/configuration as applicable), or implement another reviewed GPLv3-compliant source-delivery mechanism. Retain the GPL license and build/source identification already staged with the runtime.
3. Commit the reviewed cleanup, then perform the documented `git filter-repo` rewrite in a clean clone. Resolve the old public **unsigned** 0.1.5 provenance before changing public history, because its manifests refer to a pre-rewrite commit SHA.
4. Run `gitleaks git .` and/or a current equivalent full-history TruffleHog scan, review every result, and record the scanner versions and output.
5. Enable and verify GitHub private vulnerability reporting before public launch.
6. Decide whether to authorize a separate content-history rewrite that removes historical generated artifacts/private paths. The prepared email rewrite deliberately cannot do this because its scope requires preserving every commit tree.

## Decisions retained deliberately

- Historical Vast Pro and Supabase implementation commits remain. They document legitimate product development and the audit found environment-variable names, not embedded service-role credentials.
- Relay deployment identifiers remain public because they are routing/configuration identifiers, not authentication secrets. Cloudflare API tokens and Relay private signing keys must stay in CI/Cloudflare secret stores only.
- Useful security architecture, Chromium migration reasoning, release procedures and test infrastructure remain in the repository. Only generated output and local/private artifacts were removed.

## Final manual verification commands

Run from a clean clone after the history rewrite:

```powershell
gitleaks git .
trufflehog git file://$((Get-Location).Path) --only-verified
git log --all --format='%ae%n%ce' | Select-String -SimpleMatch 'jas.nowacki@gmail.com'
$privateProfile = 'C:\Users\' + 'j' + 'nowa'
$privateProfileJson = $privateProfile.Replace('\', '\\')
git grep -n -I -e $privateProfile -e $privateProfileJson
npm ci
npm run lint
npm test
npm run audit:ci
npm run release:audit
npm run build
```

An empty result is required from both metadata/path searches. Scanner findings must be reviewed rather than suppressed wholesale.

## Validation record

Passed on 2026-08-18:

- `npm ci` — 504 packages installed; npm reported zero vulnerabilities.
- `npm run lint` — TypeScript typecheck passed.
- `npm test` — 490 passed, 0 failed.
- `npm run audit:ci` — client and Relay each reported zero vulnerabilities.
- `npm run release:audit` — all release/security checks passed.
- `npm run build` — main, preload and renderer production builds passed.
- `npm ci --prefix relay` and `npm run check --prefix relay` — generated types current, typecheck/build passed, 30 tests passed.
- `npm run updater:stage` and `npm run test:updater` — updater and bootstrapper tests passed.
- `npm run test:fuses:integration` — real Electron binary fuse application and verification passed.
- `npm run avidae:runtime:check` — bundled service, FFmpeg, FFprobe, Playwright Chromium and hashed license inventory passed.
- `npm run test:app` — the final full command rebuilt the app and passed 63/63 app checks. An earlier attempt reached the fullscreen scenario and timed out once with an Electron sandbox renderer diagnostic; two subsequent smoke executions passed, but the flake remains documented until CI demonstrates stability.

Not run because this machine lacks the required signed release inputs or would mutate external staging state:

- `npm run test:upgrade:public` requires two real signed public versions, production URLs/release roots and the expected Authenticode signer subject.
- Relay client live E2E requires the staging admin token and creates/deletes staging broadcasts, releases and assets.
- final signed artifact download/timestamp verification requires an actual signed, published candidate; this audit was explicitly non-publishing.
