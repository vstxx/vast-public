# Targeted Electron 44.3.0 compatibility patch queue

Base: Electron `v44.3.0`, commit `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`, Chromium `152.0.7977.78`. This directory is experimental and is not loaded by Vast. The existing npm Electron binary remains unchanged.

## Accepted experimental result (2026-09-19)

The custom build at `<electron-checkout>/src/out/VastCompat/electron.exe` passes the focused native acceptance gate for patches `0004` through `0007`. `0004-electron-composed-webrequest-lifecycle.patch` is the Electron-side functional diff, `0005-chromium-lifecycle-auth-support.patch` is the matching Chromium `src/extensions` diff, and `0006-electron-messaging-split-view-compat.patch` supplies the required non-split-view `tabs.Tab.splitViewId` value for external runtime messaging. `0007-electron-action-open-popup-event.patch` forwards Electron's otherwise unsupported native `action.openPopup` call to the owning `session.extensions` instance with only the extension ID and sender WebContents ID. The rebuilt binary routed a real native iCloud iframe call to Vast and created the expected `page_popup.html` webview. Apply `0004` through `0007` to the exact bases recorded in the compatibility manifest; the older `0001` through `0003` files remain investigation history and must not be stacked on top of them.

`0008-electron-extensions-reload-api.patch` repairs the reproduced combined-profile reload defect. Vast previously emulated reload with `removeExtension` plus `loadExtension`, unloading the target with Chromium's `UNINSTALL` reason and leaving the other password manager's content scripts inactive. The patch only exposes Electron's existing `ElectronExtensionSystem::ReloadExtension` path as `session.extensions.reloadExtension`; it does not change Chromium's reload implementation. Its changed C++ translation unit passed the direct `clang-cl /Zs` syntax check, the r3 incremental build exited `0`, and the pinned binary passed the functional combined fixture matrix before and after targeted Proton reload (8/8 for both Proton and Bitwarden). The full formal Gate 3 remains separate because the run was exploratory and its isolated-gate prerequisites were not both formally complete.

`0009-chromium-css-env-fallback.patch` backports Chromium change [8263272](https://chromium-review.googlesource.com/c/chromium/src/+/8263272) to the pinned Blink parser. The installed 0.4.0 binary reproduced an authenticated ChatGPT renderer `DCHECK` in `css_variable_parser.cc:855`; a local, account-free env regression also reproduced the leading-whitespace error (`" 10px"` instead of `"10px"`) before this patch. The r4 incremental build exited `0`, and the env regression passes on its binary. However, authenticated ChatGPT still crashed with the same DCHECK through `StyleCascade::TokenSequence::AppendFallback` during nested `var()` fallback resolution. Do not treat r4 as a fixed release.

`0010-chromium-css-var-fallback-leading-space.patch` addresses that second path. CSS Typed OM intentionally preserves leading whitespace in custom-property values; when such a value becomes the first token of a nested `var()` fallback, Blink's trailing-comment scanner assumes whitespace was already stripped. An account-free Typed OM reproduction crashed r4 at the same DCHECK and stack as authenticated ChatGPT. The extended `test:electron:css-env` gate fails on r4 as expected. This patch trims only the fallback's leading HTML whitespace, leaving the original custom property untouched. The r5 incremental build exited `0`, the extended regression passes on its binary, and the user reported that authenticated ChatGPT works in the isolated r5 development session on 2026-09-28. Packaged Vast acceptance and release validation remain pending.

The accepted request order is: Electron/Vast URL deny or redirect; extension `onBeforeRequest`; extension request-header mutation; Electron/Vast final header mutation; network. Response headers run extension mutation before Electron/Vast's final mutation. Authentication gives Electron's app callback final authority and invokes extension `onAuthRequired` only when the app abstains. HTTP extension redirects re-enter the app policy. WebSocket redirects fail closed because Electron's WebSocket proxy has no safe redirected-handshake replay path.

The lifecycle repair binds Chromium's `EventRouter` interface for extension service workers, gives Electron profiles a real extension `StateStore`, routes fresh/update loads through Chromium's install notification path, persists the prior managed version, and dispatches startup once for an already installed enabled extension. A separate view-type fix classifies otherwise-untyped Electron extension-capable contents as normal tabs so `runtime.getContexts` cannot hit Chromium's `kInvalid` `NOTREACHED`.

The development-only Vast/ECE adapter is off by default and excluded from packaged bundles. Production enablement remains gated on the ECE distribution license, broader HTTPS/auth/multi-extension soak tests, and real signed-in account/autofill tests.

## Current state

The paragraphs below record the investigation before the accepted build and are retained for provenance. Their statements that the patch was unbuilt or unverified are historical.

`0001-route-and-loader-instrumentation.patch` only records the exclusive native URLLoaderFactory/WebSocket route and the extension loader's previous/incoming version. It changes no behavior. Apply it to an exact `v44.3.0` Electron source tree, build, then capture logs from the isolated harness. A functional network/lifecycle patch must follow only after this instrumentation and the Chromium EventRouter/AlarmManager trace identify the precise callback loss points.

`0002-bind-extension-event-router-in-service-workers.patch` is a **candidate**, not an accepted fix. Electron binds the extension EventRouter interface for frames but omits it for service workers. That matches the observed missing persistent worker listeners, including storage events, but the candidate has not been compiled or measured. Electron also returns `nullptr` from `ElectronExtensionSystem::state_store()`, so this binder alone cannot make alarms persistent. The loader calls `ExtensionRegistrar::AddExtension()` without an install notification and has no startup dispatch; the exact repair must distinguish fresh install, update and normal restart. Do not apply a lifecycle patch based only on these source observations.

`0001b-chromium-lifecycle-instrumentation.patch` adds behavior-neutral EventRouter, AlarmManager and RuntimeAPI logging to the matching Chromium checkout. The instrumentation is applied to the pinned Chromium checkout. No after-patch result is claimed until the custom binary runs the harness.

The two request proxies cannot be treated as independent final decision makers. `URLLoaderFactoryBuilder::Append()` chains them in call order; request headers flow outward-to-inward while response headers flow inward-to-outward. An app-first chain can preserve early hard denies, but an extension may undo an app request-header mutation. An extension-first chain lets extension cancellation/redirect precede the app policy. Both require an explicit final security rule for every phase, including WebSocket handshakes and auth. The present patches do not implement that rule.

The stock-binary acceptance baseline is automated by `../extension-compatibility-spike/verify-patch-gate.cjs --baseline`. It currently shows:

- App listener present before factory creation: Electron app callbacks work; extension webRequest receives no events for HTTP or WebSocket.
- Extension factory created first, app listener added later: the existing HTTP factory bypasses the app deny/redirect/header callback; newly created WebSocket paths use the app listener and starve the extension.
- An alarm is scheduled and removed but does not dispatch, even while a runtime port keeps the MV3 worker running for 70 seconds. A second process on the same profile does not receive the persistent alarm.
- Fresh install and subsequent startup do not deliver `runtime.onInstalled`/`runtime.onStartup`.
- Replacing the same MV3 extension's `1.0.0` manifest with `2.0.0` at the same path preserves its ID but does not deliver `runtime.onInstalled` with reason `update`.
- If app and extension listeners request different redirects, the target depends on which proxy was selected when the factory was created: app-early reaches the app target, app-late reaches the extension target.

## Build and test

Use a separate Windows checkout; do not reuse another modified Chromium tree. Electron's [Windows build guide](https://www.electronjs.org/docs/latest/development/build-instructions-windows) and [GN instructions](https://www.electronjs.org/docs/latest/development/build-instructions-gn) describe the prerequisites. Configure `<electron-checkout>` with `gclient config --name src/electron --unmanaged https://github.com/electron/electron` and tag `v44.3.0`.

```powershell
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:DEPOT_TOOLS_UPDATE = '0'
$env:DEPOT_TOOLS_ROOT = '<depot-tools>'
$env:VAST_ELECTRON_CHECKOUT = '<electron-checkout>'
$env:VAST_REPOSITORY = '<vast-checkout>'
$env:PATH = "$env:DEPOT_TOOLS_ROOT;$env:PATH"
Set-Location $env:VAST_ELECTRON_CHECKOUT
gclient sync --nohooks --jobs=12 --no-history --shallow --revision src@170c2c9ffb4da86532459d72d9eda6b4944d1670
Set-Location (Join-Path $env:VAST_ELECTRON_CHECKOUT 'src')
$electronPatch = Join-Path $env:VAST_REPOSITORY 'experiments/electron-44-patches/0001-route-and-loader-instrumentation.patch'
$chromiumPatch = Join-Path $env:VAST_REPOSITORY 'experiments/electron-44-patches/0001b-chromium-lifecycle-instrumentation.patch'
git -C electron apply --check $electronPatch
git -C electron apply $electronPatch
git apply --check $chromiumPatch
git apply $chromiumPatch
gclient runhooks
@'
import("//electron/build/args/testing.gn")
is_debug = false
symbol_level = 1
use_remoteexec = false
'@ | Set-Content out/VastCompat/args.gn
gn gen out/VastCompat
autoninja -C out/VastCompat electron
```

Run the harness with the exact custom executable, never a packaged Vast binary:

```powershell
$env:VAST_SPIKE_ELECTRON = Join-Path $env:VAST_ELECTRON_CHECKOUT 'src/out/VastCompat/electron.exe'
node experiments/extension-compatibility-spike/run-matrix.cjs patch-matrix-app-only,patch-matrix-extension-only,patch-matrix-both,patch-matrix-both-late,stock-mv3-install-events,stock-mv3-restart,stock-mv3-alarm-awake,stock-mv3-alarm-persist
node experiments/extension-compatibility-spike/verify-patch-gate.cjs
```

The second command must fail until *both* network composition and lifecycle delivery are fixed. Do not interpret a successful compile or baseline verifier as acceptance. The gate currently covers controlled HTTP and WebSocket routes and native lifecycle. The remaining HTTPS, auth, response-header, async-listener, update-reason and multi-extension cases must be added before development integration.

## Local build status (2026-09-17)

The nine locks were removed by the user and their indices rebuilt. Git dependency checkout finished, but the ordinary `gclient sync` could not finish CIPD: Windows Security quarantined a `chromium/third_party/updater/chrome_win_x86` test fixture. We did not turn off protection. The 12 Windows updater CIPD entries are inputs to the `testonly` `//third_party/updater:old_updater` target; `filter-testonly-updater-cipd.cjs` removed exactly those entries from the generated ensure file and retained 26 other entries. Manual `cipd ensure` with this filtered file exited successfully. The `//electron:electron` GN dependency graph contains no `old_updater` target. Thus the normal unfiltered dependency sync did **not** exit successfully; this build uses a narrowly filtered manual CIPD completion.

Electron's patch queue was applied, including an interrupted ANGLE patch completed with `git am`, then `gclient runhooks` exited successfully with `apply_patches=false` to avoid replaying the already applied queue. GN generation completed (31,945 targets). The first `autoninja -C out/VastCompat -j 8 electron` invocation completed about 5,650 of 46,398 steps before being stopped cleanly to make the long build independent of the interactive tool session. The same incremental build continued through the isolated checkout's `resume-vastcompat-build.ps1` in a hidden process. Its log was `vastcompat-build.log`, with completion recorded in `vastcompat-build.exitcode`. The custom binary had not yet been built or run at that point and no native patch had passed the acceptance gate. The stock baseline verifier passed by confirming the known failures; the existing Vast unit suite passed (618/618). Neither result established patched behavior.

Later incremental attempts exposed a host memory limit, not a patch compile failure. `-j 8` failed in concurrent Blink Web IDL Python generators with `MemoryError` (`vastcompat-build-failed-j8.log`). `-j 2` completed those generators and advanced 6,764 more steps (`vastcompat-build-j2.log`). `-j 6` then advanced another 5,280 steps but concurrent generated Blink binding C++ compiles failed with `LLVM ERROR: out of memory` (`vastcompat-build-j6.log`). The preserved outputs are now being continued with `-j 2` in `vastcompat-build-j2b.log`; `vastcompat-build.exitcode` contains `running` until completion. No custom executable or after-patch test result exists yet.

**Course correction (2026-09-18):** The `-j 2` process was paused before it emitted another build step. Its output directory remains intact. At that point the checkout had instrumentation only; candidate lifecycle changes were added afterward, but no functional network composition patch exists. The stock binary plus the existing disposable-profile harness already establishes the behavioral failure; source inspection establishes the exclusive routing branch. Electron's released-symbol server and Visual Studio debugger offer a path to trace additional native callbacks without first finishing this full build, subject to the optimized binary's limits. Finish the actual native patch design and use targeted object compilation for syntax feedback, then resume the same incremental `out/VastCompat` build for the required end-to-end acceptance gate. A custom executable is still necessary before claiming the patch works or is safe.

### Targeted verification attempt (2026-09-18)

The isolated checkout now also has the experimental service-worker `EventRouter` binder (`0002`) and lifecycle/state-store candidate (`0003`). These are **untested candidates**, not an accepted patch. `0003` includes the loader instrumentation from `0001` and therefore applies to the exact base tree, not on top of `0001`; it is an archival diff of the current checkout. Neither candidate changes production Vast.

We stopped the full build and tried Ninja targets for only three changed Electron objects. Ninja still parsed the 93 MB `toolchain.ninja` dependency graph for more than five minutes without starting an object compile, so that was stopped too. `compile-changed-units.cjs` then invoked `clang-cl` directly with the generated GN flags, avoiding Ninja's graph scan. It exposed missing generated headers. We ran the exact GN actions for Chrome build flags, extension JSON schemas, and the extension Mojo parse/shared/header stages. This found a real C++ type error in the lifecycle candidate; after fixing it, **`electron_extension_loader.cc` passed `clang-cl /Zs`**. The other two changed files still stop at missing generated inputs (`chrome/grit/browser_resources.h` and `components/network_hints/common/network_hints.mojom.h`), so they have not passed syntax checking. Direct compilation only becomes useful after the relevant generators have run. Do not mistake the stock baseline verifier, which still passes, for a patched result.

Run a single syntax check with `node experiments/electron-44-patches/compile-changed-units.cjs electron_extension_loader.cc` after its generated dependencies exist. It reads GN's flags from `<electron-source>/out/VastCompat` (override the source root with `VAST_ELECTRON_SRC`). It does not compile or link Electron and cannot validate event delivery, redirects, headers, or WebSocket behavior. The custom `electron.exe` was still absent at that point; the native network patch and all after-patch acceptance tests remained open.
