# Adblocker for Vast: standalone Hub distribution

Status (2026-09-06): the previous built-in implementation has been removed.
The product is now an optional `.vext`, using the same manager, toolbar, managed
store and Hub signing/review workflow as other extensions.
**Published in the Extensions Hub on 2026-09-06** (catalog-verified: slug
`adblocker`, extension ID `ighghepofocdonohadbmkbgmphppdagk`, version 1.0.0,
publisher Vast, category privacy, local-only data practice).

## Architecture

The package owns its MV2 background page, Web Worker with `@ghostery/adblocker`
2.18.2, popup, options, content scripts, picker, lists, compiled cache and stats.
Electron's session listener takes precedence over Chrome blocking listeners,
verified in Electron 44. Vast supplies a generic opt-in network provider API;
it contains no product ID, engine or lists.

Extensions declare `vast_network: 1`, `webRequest`, `webRequestBlocking` and host
permissions. Main identifies real loaded background webContents and calls the
fixed `vastWebRequest.handle` entry point with JSON data. The package worker
matches; main validates decisions and combines them with existing protections.
Without installation no product engine or list updater runs.

A browser release containing this capability is required. Older builds show an
explicit compatibility error. The number 0.2.7 alone does not identify capability
availability. Release coordination remains necessary.

No builtin catalog row, auto-install, product settings section, privileged product
IPC or application resource bundle remains. Existing migration removes legacy
`source: bundled` registrations. Legacy browser privacy protections remain.
Old builtin preferences/cache are not imported or deleted.

## Security and privacy

No Node access, new renderer IPC, remote module, eval, generated filter code or
weaker Electron security. Callback arguments are JSON data. Both page and request
must match installed permissions and the same session, and belong to a Vast-owned
HTTP(S) guest. Privileged pages are excluded; navigation/authority are rechecked.

Background callbacks time out after 500 ms; worker matching has a 180 ms deadline.
Failure permits networking. Outstanding requests are bounded to 2048 in main and
1024 in the worker client. Compilation/decoding happens in the worker.
Redirects allow bounded supported data MIME families or same-origin/path rewrites.
CSP reporting endpoints and CSS remote fetches are rejected. Content messages
cannot edit settings. Picker replies require an expiring random token and the
matching actual sender, frame and URL.

Fixed HTTPS list catalog: no credentials/referrer/redirects; 30-second timeout,
12 MiB per list, 48 MiB combined limit, structural/truncation validation. Failed
updates retain working filters. Counters are local, with no category estimates.
Changed totals are saved separately from cache every 15 seconds; crashes can lose
the latest batch. Uninstall clears only the extension's origin and native data.

Only enabled list URLs are fetched, at most daily:
- https://easylist.to/easylist/easylist.txt
- https://easylist.to/easylist/easyprivacy.txt
- https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt
- https://secure.fanboy.co.nz/fanboy-cookiemonster.txt

Publishers see connection metadata such as IP addresses. No browsing history,
request contents, statistics, analytics IDs or telemetry are uploaded. The browser
separately uses its existing Hub connections for package management.

## Performance and verification

The browser distribution excludes engine/product assets. Bundled lists work
offline. Compiled engines are fingerprinted and serialized in IndexedDB. Candidate
compilation retains the active engine until an atomic write/swap. Navigation
never reparses lists; startup does not wait for list downloads.

Local Windows/Electron observations: cold compilation 0.4-0.9 s; cached restore approximately 44-45 ms; 100 concurrent
allowed local requests 135-187 ms end-to-end. These are not isolated matching
benchmarks or a cross-device CPU/memory audit.

Executed: 595/595 Node tests including five standalone tests; browser/extension
TypeScript checks; actual archive in Electron covering requests, CSS, counters,
site controls, stale URL rejection, rejected custom edits, concurrent requests,
unload cleanup, enable/cache restore and removal. Browser restart restored custom filters and compiled cache. Hub tests: 17/17;
normal Chrome extension lifecycle E2E also passed. One earlier Hub run timed out
under concurrent builds; the isolated rerun passed. Logs/screenshots: .vast-test-artifacts/.
Older builtin test totals do not validate this replacement architecture.

## Files

| Path | Responsibility |
| --- | --- |
| src/main/extensions/extension-network-bridge.ts | Generic provider permissions, bounded callback and response validation |
| src/main/main.ts, src/main/sessions.ts | Provider registration and network/header composition |
| src/main/extensions/extension-manager.ts, extension-types.ts | Clear only uninstalled extension origin data |
| src/renderer/components/browser/ExtensionsToolbarMenu.tsx | Fix popup viewport size for all extensions |
| extensions-hub/src/validation.ts | Secure MV2 support and structural code validation |
| extensions-hub/tests/hub.test.ts | CSP, background resource and static policy regressions |
| package.json, package-lock.json | Development-only engine dependency and commands |
| scripts/build-adblock-extension.mjs | Build the separate optional package |
| scripts/adblock-extension-e2e.cjs, run-isolated-electron-e2e.cjs | Isolated real-Vast archive tests |
| tests/main/adblock-extension.test.ts | Host, schema, recovery, engine and distribution tests |
| resources/first-party-extensions/adblocker-for-vast/manifest.json | Stable identity, permissions, CSP and entry points |
| .../src/background.ts | Lifecycle, messages, swaps and page statistics |
| .../src/worker.ts, rules.ts | Compilation, cache, matching and supported syntax |
| .../src/cache.ts, settings.ts, hosts.ts | IndexedDB, bounded downloads, schema and normalization |
| .../src/content.ts, picker.ts | CSS lifecycle and confirmed selection |
| .../src/ui.ts, popup.html, options.html, style.css | Package-owned interface |
| .../assets/ | Offline lists, resources, licenses and source provenance |
| .../assets/source/provenance.json | Individual hashes/inventory of unchanged upstream files |
| .../README.md, LICENSE.txt, tsconfig.json | Reproduction, license and independent type checks |
| artifacts/Adblocker-for-Vast-1.0.0.vext | Unsigned publisher upload |
| artifacts/Adblocker-for-Vast-Hub-listing.json | Prepared public listing metadata |

## Limitations and release gates

- Publisher upload, review, signing and public catalog publication completed on
  2026-09-06; the public catalog lists the extension. Cloudflare administration
  is not a Hub session. No authentication or review bypass was introduced.
- Vast 0.2.7, the current public release, contains the required
  network-provider capability; older builds show a compatibility error.
- MV2 works in the tested Electron build but is deprecated upstream. Revalidate
  every Electron upgrade.
- Page scriptlets, non-native procedural selectors, response-body rewriting, CSP
  reporting and custom list URLs are unsupported. List omissions are counted;
  unsupported custom rules fail without replacing working filters.
- No tracker category counts; browser and other-extension blocks are excluded.
- Private workspaces do not run this Chrome extension. Requests without an owned
  page identity, including some background service-worker traffic, bypass it.
- Activation is asynchronous. Reload pages whose resources loaded before readiness;
  changing CSP also requires reload. Counts are per persistent workspace.
- No fresh broad real-world site-breakage audit of this standalone architecture
  has been completed. It must not be called production certified on that basis.

## Licensing

Original standalone integration: GPL-3.0-or-later. Engine and @remusao components:
MPL-2.0; tldts: MIT. EasyList/EasyPrivacy: GPL option of their dual license.
uBlock filters/resources: GPL-3.0 (or later where stated). Cookie notices:
CC-BY-3.0. Exact versions, copyrights, source links and full texts are included in
assets/THIRD-PARTY-NOTICES.txt, DEPENDENCY-LICENSES.txt and individual licenses.
Pinned readable resource source and the offline generator are included. Evaluated
Peter Lowe and Polish regional distributions were excluded for noncommercial
terms. Defaults: EasyList and EasyPrivacy; other bundled lists are optional.

## Manual release checklist

- Clean compatible profile: absent until installed from Hub.
- Verify official publisher, stable ID, version and signed consent.
- Install/reload: actual blocked requests and hidden placeholders.
- Site/global/cosmetic toggles, subdomains, tabs and workspaces.
- Picker preview/confirm/ESC; imports/exports; failed update; offline start.
- Restart: custom filters, allowlist and compiled cache survive.
- Disable/enable/uninstall: no residual filtering or product row.
- Internal/private pages, downloads, media, iframes, WebSockets and SPAs.
- News, YouTube, Reddit, Google/search, docs, ecommerce and embedded video.
- Verify public catalog and signed installation on a second profile.

## Production Hub deployment

The tested validator was deployed on 2026-09-06:
- Hub: `e21b2353-8d52-42c1-b2e1-35a6424f67bd`
- Private signer: `1d8fc437-0cff-44b0-b11a-3fea8b41044e`

Public catalog verification on 2026-09-06 lists IDU+ 0.3.8 and Adblocker for
Vast 1.0.0 (slug `adblocker`, extension ID `ighghepofocdonohadbmkbgmphppdagk`,
local-only data practice). Upload used the prepared archive and listing JSON
through `/dashboard` on extensions.vastbrowser.com; the listing's explicit
extension ID matched the archive, and no separate identity was generated.

Final verification: production Hub health, private signer proof and the existing
IDU+ descriptor signature passed `npm run hub:verify:production`. Final browser
build passed with the internal test harness disabled. Bundle budgets passed:
main 487,889 bytes; preload 14,558; initial renderer 1,120,077; total JS 6,678,008.
Archive SHA-256: `4e12b30f0cfcbf9d1c728984ce37fa0b9f6fa5baa5c4f5920d485031d36a68ac`.
