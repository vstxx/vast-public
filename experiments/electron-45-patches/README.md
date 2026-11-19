# Electron 45 compatibility patch queue

Base: Electron `v45.3.4` (`f3d1a2f654d6e7ccdbc5ccdd022b147fa05f064e`), Chromium `156.0.8078.100`. This is the `electron-45.3.4-vast-r1` patchset pinned in `patches/extension-compatibility-runtime.json`.

Apply in order: `0004`, `0006`, `0007`, `0008` to `src/electron`; `0005`, `0010` to `src` (after Electron's own patches, i.e. after `gclient runhooks`). Build with `../electron-44-patches/vast-release-profile-args.gn`.

## Rebase from 45.2.3 (2026-11-19)

Security update: 45.3.0 to 45.3.4 bring Chromium 156.0.8078.100 with upstream Chromium, V8, ANGLE, Dawn and Skia backports, distrust of eMudhra's revoked intermediates and Node.js 24.22.3.

`0005`, `0006`, `0007`, `0008` and `0010` apply unchanged.

`0004` was re-applied with a three-way merge. The only conflict is in `proxying_url_loader_factory.h`: upstream #55656 adds `redirect_count_` next to `redirect_url_`, where `0004` adds its extension-router fields. Both are kept. The redirect limit lives in `ContinueToBeforeRedirect`, which the extension router path also goes through, so `net::URLRequest::kMaxRedirects` bounds extension-driven redirects too.

Release-profile build (official, PGO, ThinLTO, about 5.5 h at `-j16`): `electron.exe` is 250,072,576 bytes, SHA-256 `976eb139a42d130f19dcaeadc4cf8fe7ebe0e06c33ae118ce14d916d3c3cba64`. The CI cache is `ci-cache-electron-976eb139a42d130f`, archive SHA-256 `ca233f55…`. The native patch gate (`verify-patch-gate.cjs`) passes on this binary. It covers HTTP and WebSocket webRequest composition, app-authoritative auth with extension fallback, install, update, startup and alarm lifecycle events.

## Rebase from 45.0.0 (2026-11-07)

`0006`, `0007`, `0008` and `0010` are unchanged. Their target files did not change upstream.

`0004` was cherry-picked onto 45.2.3 with a three-way merge. The extension loader conflicted only in its includes: upstream split `FinishExtensionLoad` to unregister a stale extension service worker first. Our install/update/startup logic now runs in upstream's `AddLoadedExtension`. Removed from `0004`:

- the extension `StateStore`. Upstream now creates the state, rules and dynamic-scripts stores itself, and also handles in-memory sessions.
- the extension service-worker `EventRouter` binder. Upstream #55154 binds it.
- the `[vast-compat]` diagnostic logging.

`0005` loses its logging-only `alarm_manager.cc` and `runtime_api.cc` hunks.

Kept from upstream and not touched by the queue:
- #55271: `WebRequestHost` binders for frames and extension workers. Without them, blocking `chrome.webRequest` listeners stall requests. Electron 45.0.0 lacked this fix.
- `HasWebRequestAPIProxy`.
- Real `tabId`s in extension `webRequest` details (`GetTabAndWindowIdForWebContents`).
- Extension service-worker registration policy (`AllowServiceWorker`, `MayDeleteServiceWorkerRegistration`).
- Sandboxed extension pages in their own process.
- `chrome.storage.sync`.

`0010` is still needed: `StyleCascade::TokenSequence::AppendFallback` in 156.0.8078.80 still does not strip leading whitespace.
