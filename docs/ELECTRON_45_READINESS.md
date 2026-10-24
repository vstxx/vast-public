# Electron 45 readiness (2026-10-22)

Previous runtime: Electron **44.7.0** + Vast patchset `electron-44.7.0-vast-r1` (Chromium 152.0.7977.130).
Current runtime: Electron **45.0.0** + Vast patchset `electron-45.0.0-vast-r1` (Chromium 156.0.8078.48, Node 24.22.0, V8 15.6.75.19), release GN profile, pinned in `patches/extension-compatibility-runtime.json`.

## Switch record (2026-10-23)

**Status: switched on this branch.** Native build `D:\VastElectron45\src\out\VastRelease`: Electron `54f961b4` (v45.0.0), Chromium `2159036d`, patches 0004–0008 and 0010. The only other change in the tree is Electron's own two BoringSSL patches.

- `electron.exe` 249,769,472 bytes, SHA-256 `756a541e66b4d144c15cb41ab35f0d627d6cf997900f91fb5b072e09a06c3e67`. `verify-electron-release-profile.cjs --require-binary` passes (official, PGO phase 2, ThinLTO, DCHECK off).
- Patchset SHA-256 `98e36c20715957b3b0f489fc9c7c8e531e4ae3c58a3f3ff534dd26b6edf8b4cb`. Evidence snapshot: `audit/evidence/vast-electron-45.0.0-runtime-manifest.json`.
- Prepared distribution `.vast-build/electron-dist/electron-45.0.0-vast-r1-win32-x64` (73 files); `verify-extension-compat-runtime.cjs` and `verify-electron-version.cjs` pass.
- Passed on the 45 binary: `npm test`, `test:release`, `test:extensions:e2e`, `test:adblock:extension-e2e` (cold init 553 ms), `test:electron:css-env`.
- CI cache: `third_party/electron/electron-ci-cache.json` names tag `ci-cache-electron-756a541e66b4d144`, asset `electron-45.0.0-vast-r1-win32-x64.zip` (158,117,204 bytes, SHA-256 `b6c75b6cad553daaad42646c86b01785fb34f1fd008fd55ae842222ee908f84b`), built at `.vast-build/electron-cache-candidate/` and verified with `restore-patched-electron-cache.cjs`. **CI cannot use it until that private release asset is uploaded.**
- Still manual: password-manager inline menus (Bitwarden, Proton Pass, iCloud) and `action.openPopup`, screen sharing (picker, WebRTC-disabled policy, Windows audio share), packaged smoke.

The sections below are the pre-switch analysis.

## 1. Native patch queue

The source of every touched file was fetched at `v45.0.0` / `156.0.8078.48` and each patch was applied with `git apply --check` (no fuzz). The same method applies the current queue cleanly to `v44.7.0` / `152.0.7977.130`, which validates it.

| Patch | Purpose | On 45 as-is | Rebased queue (`experiments/electron-45-patches/`) |
| --- | --- | --- | --- |
| 0004 electron | webRequest composition (app + extension), WebSocket and auth routing, extension lifecycle (install/update/startup, state store, service-worker EventRouter) | 4 files conflict | Applies. Two real conflicts resolved by hand (see below). |
| 0005 chromium | previous-version tracking for `onInstalled` update, composed-auth access, navigation throttle for app-owned `<webview>`s; `[vast-compat]` logging | context drift in `alarm_manager.cc` | Applies. |
| 0006 electron | `tabs.Tab.splitViewId` for external messaging | applies | Applies. |
| 0007 electron | native `action.openPopup` → `session.extensions` event | applies | Applies. |
| 0008 electron | `session.extensions.reloadExtension` | applies | Applies. |
| 0009 chromium | backport of Chromium 8263272 (`env()` fallback, ChatGPT crash) | conflicts | **Dropped: already in Chromium 156** (`ResolveEnvInto` uses `AppendDataWithFallback`). |
| 0010 chromium | trim leading whitespace in nested `var()` fallbacks (ChatGPT crash) | conflicts | Applies. **Still needed**: `AppendFallback` in 156 has no trim. |

Every rebased patch makes byte-for-byte the same added/removed lines as its Electron 44 original (sorted `+`/`-` line sets compared). Only context and line numbers changed.

Conflicts resolved by hand:
- `electron_extension_loader.h`: upstream switched `callback.h` to `callback_forward.h`; the `flat_set.h` include moved accordingly.
- `proxying_url_loader_factory.cc` `ContinueToResponseStarted`: upstream now clones the response and moves `cache_storage_side_data_writer`. The extension `OnResponseStarted` hook is placed after the app callback, as before.

Upstream changes near the hooks that need a **compile and behavior check**, not only a text check:
- `ElectronBrowserClient::WillCreateURLLoaderFactory` gained `bool is_for_network_service`. 0004 rewrites this function's routing.
- `LoginHandler::EmitEvent` now emits `login` on `app` and the WebContents with one shared event. 0004 still keys off `default_prevented`, so app authority over auth is unchanged, but it must be retested.
- `alarm_manager.cc` and `runtime_api.cc` were refactored upstream (histograms removed). The 0005 hunks there are logging only.

SHA-256 of the rebased files:

```
adb0ed9ae3a702c7fe42a8f22971893d8b426f6a5a27524c0e91ba391978af59  0004-electron-composed-webrequest-lifecycle.patch
873db23065e12a478da0650da094b1b0c5144c5fae254e583f6a9fbc71431267  0005-chromium-lifecycle-auth-support.patch
0e7f3c01e120bc70d0c31413492a64ede4b8d9de71973534eb46695c8f47c99a  0006-electron-messaging-split-view-compat.patch
3ee98fa55b4af641418d714c7a97f4671394bad3f6de99235e597082f5201426  0007-electron-action-open-popup-event.patch
fad0e0fd56c2cc2de5c29bd9cf089ec816ae2247058bb5eefc573576ab78d0fb  0008-electron-extensions-reload-api.patch
b5bb98b01c5d630f6d28cb44771d4a3b31d60e5e31ee0d494b99ac196eff2f8e  0010-chromium-css-var-fallback-leading-space.patch
```

## 2. Electron 45 breaking changes against Vast

| Change | Vast impact | Status |
| --- | --- | --- |
| Screen/window/tab capture reported as `display-capture` instead of `media` | **Blocker.** `permissionPolicy` returned `block` for unknown permissions, so screen sharing would be denied before Vast's picker. | **Fixed on this branch** (works on 44 and 45): `display-capture` is gated like Electron 44's empty `media` request, including the WebRTC-disabled policy. The display-media handler still requires a user gesture and a picked source. Test: `tests/main/display-capture-permission.test.ts`. |
| `chrome-extension://` frames embedded in ordinary pages no longer receive session preloads | ECE registers `chrome-extension-api.preload.js` as a session `frame` preload. Embedded extension iframes (password-manager inline menus: Bitwarden, Proton, iCloud) lose the ECE-provided APIs (`tabs`, `action`, `windows` …). Native APIs (`runtime`, `storage`, `i18n`) are unaffected. | **Needs a gate**: password-manager inline-menu and autofill E2E on the 45 build. If it breaks, the ECE patch must route those calls through the top-level extension context or a native API. |
| Sandboxed preloads lose `events`/`timers`/`url` shims and `Buffer`/`setImmediate`/`clearImmediate` | Built `index.js`, `guest.js`, `extension-host.js` and ECE's `chrome-extension-api.preload.js` were scanned: none use them. | OK. |
| Sandboxed renderers skip Electron's JS bundle unless `webviewTag` | The main window uses `webviewTag`. Guests are sandboxed with a preload. | Verify guest preload startup and the earlier `binding.startupData is null` diagnostic on 45. |
| ASAR file descriptors are no longer temporary copies | Vast uses `createReadStream`, which is supported. No raw descriptor consumers in `src/`. | OK. |
| `window.open()` children with a different sandbox state get their own process | Vast windows and guests are sandboxed. | OK; covered by popup E2E. |
| `safeStorage` sync methods deprecated (removed in 46) | Not used. | OK. |
| `openAsHidden` login-item options removed, `contentTracing.enableHeapProfiling` removed, `requestStorageAccessFor` disabled, 32-bit builds removed | Not used. Vast ships win32-x64 only. | OK. |
| `getUserMedia({ chromeMediaSource: 'desktop' })` rejects WebContents IDs | Not used. | OK. |
| Clipboard promise API | Already in Electron 44; Vast uses `clipboard.writeText` only. | OK. |
| Fuses | `build/fuses/fuses.json5` is identical in 44.7.0 and 45.0.0. | OK; `scripts/electron-fuses.cjs` unchanged. |

## 3. Dependencies

- `electron-chrome-extensions` 4.9.0 is still upstream's latest (last published 2025-07). Vast's ECE patch is JavaScript and independent of the Electron version, apart from the preload change above.
- `electron-builder` 26.15.3 and `electron-updater` 6.8.9 are current.
- `electron-vite` 5.0.0 maps unknown Electron majors (both 44 and 45) to Chrome 142 / Node 22.20 build targets. Same behavior as today; 6.0.0 exists but is not needed for the switch.
- `@electron/fuses` 2.1.2 (2.1.3 available) works with the unchanged fuse schema.

## 4. Switch procedure

1. Fresh checkout of Electron `v45.0.0` in a separate directory (do not reuse `D:\VastElectron44`). Chromium 156 sync plus a release build needs roughly 150–250 GB; D: has about 480 GB free.
2. Apply `experiments/electron-45-patches/` in order: 0004, 0006, 0007, 0008 to `src/electron`; 0005, 0010 to `src`.
3. Build with `experiments/electron-44-patches/vast-release-profile-args.gn` (official release, PGO, ThinLTO, `DCHECK` off). Run `scripts/verify-electron-release-profile.cjs`. Allow for the memory limits seen on 44 (`-j 3`).
4. Update `patches/extension-compatibility-runtime.json` (version, base commits, patch hashes, binary size/hash, revision `electron-45.0.0-vast-r1`), `package.json` `electron` to `45.0.0`, the CI cache archive and `scripts/verify-electron-version.cjs` expectations.
5. Gates on the 45 binary, all with disposable profiles:
   - extension compatibility matrix (`verify-patch-gate.cjs`): HTTP/WebSocket composition, auth, alarms, `onInstalled`/`onStartup`, update reason
   - `npm test`, `test:release`, `test:extensions:e2e`, `test:adblock:extension-e2e`, `test:electron:css-env` (the ChatGPT `var()`/`env()`/Typed OM regressions)
   - password managers: Bitwarden, Proton Pass, iCloud Passwords inline menus, autofill and `action.openPopup`
   - screen sharing (Meet or a fixture): picker appears, WebRTC-disabled policy blocks, audio share on Windows
   - packaged smoke, launch health and guest performance compared with the 44.7.0 release build

Nothing above has been run on an Electron 45 binary yet.
