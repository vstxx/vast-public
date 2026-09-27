# Adblocker for Vast 1.1.0

Prepared locally on 2026-09-14. This update belongs to the existing `adblocker`
Hub listing, publisher Vast (`publisher_7b1e2c9f4a806d3e5b709c12`), extension ID
`ighghepofocdonohadbmkbgmphppdagk`. The original manifest RSA key is preserved.
Version 1.0.0 was published previously; this work does not publish 1.1.0.

## Architecture and filtering

The optional extension owns its persistent MV2 background, Ghostery 2.18.2 Web
Worker, lists, resources, IndexedDB cache, local counters, content scripts and UI.
The browser distribution contains neither its engine nor its list assets.

Supported mechanisms:

- Network filters and exceptions, redirects/surrogates, compatible CSP rules.
- Ordinary CSS cosmetics and exceptions.
- Ghostery-supported extended/procedural selector ASTs and directives, including
  dynamic text/attribute matches and element removal. Unsupported AST syntax is
  counted for lists and rejected for custom filters.
- Safe packaged scriptlets from ordinary lists and custom filters.
- Trusted packaged scriptlets exclusively from code-owned approved uBlock IDs.
- Top-level HTTP(S) MAIN-world scriptlets prepared before document preload.

The standard engine receives network rules, safe cosmetics and safe scriptlets.
The trusted engine receives only trusted scriptlet rules from approved lists,
plus applicable exceptions. List text, settings and messages cannot grant trust.
Custom/imported rules never receive the trusted resource library. Failed custom
edits do not replace the active engine. Trusted resource/engine failure leaves
normal network blocking available and reports degraded advanced protection.

Ghostery owns filter parsing, aliases, conditions and exceptions. Its parsed
arguments are passed as JSON to unchanged pinned scriptlet functions. The adapter
shares dependencies within each document payload instead of repeating them per
rule. No downloaded JavaScript body is evaluated or compiled. All executable
bodies come from the reviewed extension package.

`resources-safe.json` excludes `requiresTrust` entries and contains redirects.
`resources-trusted.json` contains the full scriptlet dependency closure and no
redirects. Both reproduce byte-for-byte from pinned uBlock 1.74.0 source commit
`6dd2d95e50d134a477a4e183343c0b26e9147123`; source hashes and licenses are shipped.
The extension build runs the generator's offline `--check` gate.

HTML response-body filtering remains disabled (`cap_html_filtering = false`).
There is no proxy, MITM, remote custom list URL, arbitrary page execution API or
YouTube-specific browser patch. Maintained lists supply site-specific rules.

## Document-start authority

`vast_document_rules: 1` requires `vast_network: 1`, blocking request permissions
and an explicit persistent MV2 background. Local and Hub validators include the
new capability in the permission snapshot, so upgrades require permission review.

Main recognizes installed background webContents, session and host permissions.
During main-frame request handling it asks that provider's fixed handler to
prepare document rules in its existing worker. Pending rules bind to the exact
guest ID, URL and navigation generation. Browser-owned isolated preload consumes
rules synchronously once and executes them in MAIN without exposing Node or an
extension execution API to the page. The IPC reply is assigned exactly once;
assigning an empty fallback first would send that empty reply immediately.

Consumption requires the current main frame, matching URL/session and a live
Vast-owned guest. Internal, extension, DevTools, credential-bearing and
OAuth/auth-sensitive browser flows are excluded. Navigation, destruction,
disable and uninstall invalidate pending rules. Limits: 15-second TTL, 256
pending guests, eight providers, 128 scripts and 512 KiB aggregate UTF-8 payload.
Malformed, oversized, stale or timed-out responses fail open.

The main callback remains bounded to 500 ms; worker operations to 180 ms
(initialization has a separate 45-second allowance). Advanced-operation timeout
does not intentionally stop the standard worker. Unresponsive network providers
are removed until re-enabled; browsing continues.

## Lists, settings and privacy

| Fixed list | New-profile default | Cadence | Trusted scriptlets |
| --- | --- | --- | --- |
| EasyList | On | Daily | No |
| EasyPrivacy | On | Daily | No |
| uBlock Origin filters | On | Daily | Yes |
| uBlock Quick fixes | On | Six hours | Yes |
| uBlock Unbreak | On | Daily | Yes |
| uBlock Privacy | On | Daily | Yes |
| EasyList cookie notices | Off | Daily | No |

Exact official URLs and source policy are centralized in `src/settings.ts`.
Downloads use the existing fixed HTTPS catalog, no credentials/referrer/redirects,
ETag/Last-Modified validation, a 30-second deadline and 12 MiB per-list/48 MiB
combined limits. Invalid or failed updates preserve last-known-good filters.
Only selected lists update; unchanged bodies are not downloaded again.

Schema 1 migrates explicitly to schema 2, preserving selected lists, allowlists,
custom filters, enabled state and statistics. New advanced protection defaults
on, with a separate advancedAllowlist. Existing list selections remain intact;
existing users can opt into the added lists. Engine fingerprints invalidate old
compiled caches intentionally. Statistics remain separate, local and batched.

Options add Advanced site protection and readable list metadata. Popup controls
blocking, cosmetics and advanced protection independently for the exact hostname.
Reload after changing scriptlets: already executed page patches cannot safely be
reversed. Content refresh removes cosmetic styles/attributes and observers;
page effects of destructive remove directives also require reload to restore.

## Performance

Compilation stays in the worker; navigation never reparses lists. Both engine
caches are fingerprinted and replaced atomically. Document matches cache up to
64 URLs for 60 seconds. Ghostery DOMMonitor sends feature deltas; procedural rules
batch changed roots at 200 ms and yield between selectors. There are limits on
rules, roots, tracked elements and features. No repeated whole-page polling was
added. A single expensive native selector cannot be preempted mid-query.

Windows x64 / Node 24.18.0 measurements from this machine:

| Measurement | Result |
| --- | --- |
| Node cold initialization, six default lists | 590 ms |
| Node cached initialization | 40 ms |
| Allowed request, 10,000 samples, mean / p95 | 0.00257 / 0.00330 ms |
| Blocked request, 10,000 samples, mean / p95 | 0.00283 / 0.00310 ms |
| YouTube rule preparation (matching only) | 1.88 ms, 112,787 bytes |
| Combined compiled engines | 6,645,146 bytes |
| Default list text / resource text | 4,634,646 / 546,102 bytes |
| Retained Node heap increase after GC | 5,170,456 bytes |
| Node process RSS increase after compilation | 289,746,944 bytes |
| Electron cold / cached initialization across observed runs | 498-1,858 / 63.9-68.9 ms |
| Electron 100 allowed / blocked concurrent local requests | 55-118 / 13-115 ms |
| Electron 1,000 dynamically inserted ad elements hidden | 264-541 ms |

The original 1.0.0 worker and its original two default lists measured 449 ms
cold, 5,622,177 compiled bytes, 3,696,296 retained heap bytes and 273,281,024 RSS
increase. New default coverage has a measurable cost: approximately 141 ms cold,
1.0 MB serialized cache and 1.5 MB retained heap in these single-process samples.
RSS includes V8 reservations/compilation allocation and is not browser steady-state
RAM. Electron timings varied with concurrent local work, including Hub tests.
These are observations, not universal budgets or full-site latency figures.

Reproduce with `node --expose-gc scripts/benchmark-adblock-extension.mjs`.
Browser JS size gates passed; no engine code entered the renderer build.

## Verification and limitations

Local commands and results (2026-09-14):

| Command | Result |
| --- | --- |
| `npm run extension:adblock:typecheck` | PASS |
| `npm run extension:adblock:build` | PASS; source/resource/provenance checks included |
| `node --test tests/main/adblock-advanced.test.ts` | PASS, 15/15 |
| `npm test` | PASS, 622/622 in the current workspace |
| `npm run lint` | PASS |
| `npm run hub:typecheck` | PASS |
| `npm run hub:test` | PASS, 17/17 |
| `npm run test:extensions:e2e` | PASS |
| `npm run test:extensions:native-e2e` | PASS |
| `npm run test:adblock:extension-e2e` | PASS |
| `node scripts/adblock-extension-e2e.cjs` | PASS against the final archive |
| `npm run performance:budget` | PASS |
| `node --experimental-transform-types scripts/verify-adblock-extension.mjs` | PASS; actual Hub validator and exact archive/source equality |
| Gitleaks directory scan of the extracted final archive | PASS; no leaks, existing narrow config |

The unsigned archive contains 127 files. Verification checks every archive byte
against source, all recorded asset hashes, stable identity/key, notices/licenses,
forbidden native/development files, private keys and absolute workstation paths.

The deterministic fixture tests early constants, approved trusted rules, safe
fetch/XHR JSON pruning, trusted response replacement preserving normal data,
extended cosmetics and exceptions, SPA mutations, reload, per-site advanced-only
control, rejected custom edits, OAuth exclusions, oversized/malformed responses,
timeout fail-open, concurrent requests, unload, restart, cached restore and removal.
Unit tests also cover stale URL/generation, TTL, authority rejection, internal
pages, trusted-domain failure, source trust and schema migration.

Anonymous live navigation checks reached YouTube watch/live, Reddit, Twitch,
Facebook, X, BBC News and Amazon. This is not a playback/ad-removal acceptance
certificate: YouTube watch showed a player at metadata readiness; live playback
was not established. Playlist and Shorts reached Google's consent page. Direct
embed navigation reported player error 153. Google account navigation did not
complete in the harness. Facebook/X were logged-out screens. Logged-in feeds,
full video playback, consent-driven flows and reliable embed playback still need
manual acceptance. No promise of perpetual or complete YouTube ad blocking.

Other limits: private workspaces do not run this Chrome extension; traffic
without a Vast-owned page (including some service workers) bypasses it. Early
scriptlets are top-level only; cosmetic content scripts are frame-aware. Engine
startup is asynchronous, so reload pages opened before readiness. MV2 must be
revalidated with each Electron upgrade.

## Manual Hub submission

1. Release a compatible Vast build exposing document rules API 1. The existing
   public product version alone is insufficient. Older network-capable builds
   retain normal blocking and display an advanced-protection compatibility notice.
2. Deploy the tested Hub validator change through the normal approved process so
   the new capability is included in signed permission snapshots. Do not bypass
   the additional permission review for this update.
3. Upload `artifacts/Adblocker-for-Vast-1.1.0.vext` under the existing `adblocker`
   listing and Vast publisher, using `artifacts/Adblocker-for-Vast-Hub-listing.json`.
4. Complete normal reviewer approval/signing and test the signed update on another
   profile, including preserved settings and permission consent.

The package passes the actual Hub static validator. Ghostery's generated worker
contains long compiled data lines, which retain the existing manual-review flag;
that review has not been bypassed. Preserve the included licenses, corresponding
source and provenance. No production deployment/submission is part of this work.

## Materially changed files

- `.gitattributes`: preserve exact upstream LF bytes.
- `resources/first-party-extensions/adblocker-for-vast/manifest.json`,
  `src/settings.ts`, `src/cache.ts`, `src/rules.ts`, `src/engine.ts`,
  `src/worker.ts`, `src/background.ts`, `src/content.ts`, `src/procedural.ts`,
  `src/ui.ts`, `popup.html`, `options.html`, `README.md`.
- The extension's `assets/source/compile-adblock-resources.mjs`,
  `assets/source/README.md`, `assets/resources-safe.json`,
  `assets/resources-trusted.json`, fixed list snapshots, `assets/provenance.json`,
  `assets/THIRD-PARTY-NOTICES.txt` and exact upstream license line endings.
  Obsolete `assets/resources.json` was removed; pinned upstream code is unchanged.
- `src/main/extensions/extension-network-bridge.ts`,
  `src/main/extensions/extension-document-rules.ts`,
  `src/main/extensions/extension-manifest.ts`, `src/main/sessions.ts`,
  `src/main/ipc.ts`, `src/preload/guest.ts`,
  `src/shared/extension-document-capability.ts`.
- `extensions-hub/src/validation.ts`, `extensions-hub/tests/hub.test.ts`.
- `scripts/build-adblock-extension.mjs`, `scripts/update-adblock-assets.mjs`,
  `scripts/benchmark-adblock-extension.mjs`, `scripts/verify-adblock-extension.mjs`,
  `scripts/adblock-extension-e2e.cjs`.
- `tests/main/adblock-extension.test.ts`, `tests/main/adblock-advanced.test.ts`,
  `docs/ADBLOCKER_FOR_VAST.md` and the two submission artifacts below.

Final archive: `artifacts/Adblocker-for-Vast-1.1.0.vext` (2,317,817 bytes).
SHA-256: `0ca20eabb5fa8feb89cff60056cccb6c52e0f701cfe02eb024120d64a65b5213`.
Listing: `artifacts/Adblocker-for-Vast-Hub-listing.json`.
