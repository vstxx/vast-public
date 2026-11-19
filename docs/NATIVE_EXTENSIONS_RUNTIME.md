# Native extensions runtime: audit, decision and results

Branch `feat/native-extensions-runtime` (from `master` 540a443). Electron 45.0.0-vast-r1 (Chromium 156), Windows 11, i7-14650HX. Benchmarks: `scripts/native-extensions-bench.cjs`, isolated temporary profiles, three repetitions, medians. Raw data: `C:\Users\jnowa\NativeExtBench\{before,after,throttle-off,throttle-on}.json`.

## 1. Audit (code as of master)

| # | Finding | Where (master) | Effect |
|---|---|---|---|
| 1 | `vast.background` was mandatory for any Native layer | `extension-manifest.ts` `validateVastSection` ("must declare vast.background") | A toolbar button needed a hidden `BrowserWindow`, a renderer process and ~25 MB private memory |
| 2 | Contributions existed only in memory, created by the running background, removed with it | `extension-contributions.ts`, `extension-manager.ts` `ensureNativeRuntime` (`removeExtension` on stop/error) | No static UI was possible; restore after restart depended on running extension code |
| 3 | `start()` always stopped and recreated the host | `extension-native-runtime.ts` `start` (`await this.stop(record.id)`) | Every `enable` of an enabled extension, every grant and every duplicate unpacked install restarted it (measured: 5 redundant enables → 5 extra hosts) |
| 4 | Dispatch claimed success without a receiver | `extension-manager.ts` `dispatchContribution` (`this.nativeRuntime?.send(...)` then `return true`) | Clicks were reported as executed when no host or listener existed |
| 5 | Contribution keys were `<ext>:<id>` across all types | `extension-contributions.ts` `key`/`ownerFor` | A toolbar action and a command with the same ID collided; the command delivered `toolbar.onClicked` |
| 6 | Tab-event reporting always ran | `renderer/extensions/extension-runtime.tsx` `ExtensionRuntimeController` | Full tab enumeration per store change and ~6.4 IPC/s during ordinary browsing with zero Native extensions |
| 7 | Context-menu context was spread unvalidated into the event | `extension-manager.ts` `{ menuItemId, ...(context ?? {}) }` | Payload schema relied on the renderer |
| 8 | `pending-permission` left a running host running | `startNativeIfAllowed` | State said "pending" while code ran |
| 9 | Chromium `chrome.contextMenus` items were never shown | no consumer of ECE `getContextMenuItems`; `extension-compatibility.ts` claimed "visibility works" | Hybrid/Chromium menu items were invisible |

Also verified: every extension IPC handler passes `assertTrustedIpcSender` (Vast window, main frame, trusted URL); `vast-native:call` derives authority from the sending `webContents`; private/ephemeral workspaces get no extension sessions; toolbar/palette/menu entries are hidden in private workspaces.

Inventory: no first-party extension (`resources/first-party-extensions`), and no Hub artifact (Adblocker 1.0.0/1.1.0, Bitwarden, Proton Pass, IDU Plus) declares a `vast` section. Native API v1 consumers are the test fixtures `vast-native-basic` and `hybrid-basic`.

## 2. Decision

| Option | Verdict |
|---|---|
| A. Optimize v1 runtime | **Adopted** for hosts that must exist: no redundant restarts, accurate states, acknowledged delivery, cleanup on stop/crash |
| B. Declarative contributions | **Adopted**: additive `vast.contributes`, no version bump; removes the host for static UI |
| C. Event-driven/suspendable native host | **Rejected**: guaranteeing no lost events across start/suspend/crash needs a queue and lifecycle scheduler; B plus on-demand popups/panels (which already get the `vast.*` API) covers the need without it |
| D. Reuse Chromium MV3 for hybrids | **Adopted through existing mechanisms only**: a declarative `popup` action opens the Chrome action popup in the active persistent workspace (existing `open-popup` route and `prepareSurface` checks), and ECE's own `chrome.contextMenus` is now rendered. No new bridge between the Vast and Chrome layers |

`backgroundThrottling: false` was kept. A/B with a host polling every 16 ms (~2 ms work per tick): idle CPU 9.4 % (off) vs 10.6 % (on), event delivery unchanged. A never-shown window is not throttled within this horizon, so the change has no measured benefit and would alter v1 timer behaviour.

## 3. Implementation

- `src/shared/extension-native-contributions.ts`: one parser for client and Hub. Sections `toolbar` (5), `commands` (50), `context_menus` (50), `sidebar` (5); closed action set `popup` | `event`; per-section permission must be requested; local typed assets; contexts `all|page|selection|link`; bounded click payload (`contextMenuClickPayload`). Loaded on demand by the manifest validator.
- Manifest: `background` optional; a Native layer needs one of `background`, `popup`, `options`, `contributes`. Invalid `contributes` disables only the Native layer (diagnosable), like an unknown permission.
- Registry: entries carry `source` (`manifest`/`runtime`), `action`, `available`, optional verified `iconDataUrl`; keys are `<ext>:<type>:<id>`; a background cannot shadow, edit or remove manifest entries; `removeRuntime` on stop/crash keeps manifest entries; snapshot carries `nativeTabEvents`.
- Manager: `startNativeIfAllowed` registers manifest entries from persisted grants, starts a background only if declared (`idle` otherwise), stops hosts on pending/incompatible. `dispatchContribution` re-reads record, enablement and the section's grant, validates the context schema, and either returns `popup` (opened in the requesting window) or awaits `deliver`.
- Runtime: `start` keeps a running host when version, root and `vast` section are unchanged; `deliver` sends a delivery ID and resolves only on an acknowledgement from that host (`vast-native:event-ack`, sender-checked) with ≥1 listener; rejects on no host, no listener, crash/stop, or 3 s timeout.
- Renderer: tab-event reporter mounted only while `nativeTabEvents`; mounting takes a baseline without synthetic history. Toolbar uses verified icons and disables unavailable actions; palette hides unavailable commands; page menu filters by contexts and shows ECE `chrome.contextMenus` entries (labels + single-use tokens; guest ownership checked in main).
- Hub: `validatePublisherPackage` runs the same parser and checks referenced files exist in the signed package.

Public API impact (all additive): `vast.contributes`; `contextMenus.create({ contexts })`; native state `idle`; snapshot fields `source`, `action`, `available`, `iconDataUrl`, `nativeTabEvents`; `dispatchContribution` returns `outcome`. Behaviour changes: actions without a listener now report an error; a manifest-declared ID cannot be re-created at runtime; contribution keys changed format (opaque).

## 4. Performance (medians of 3)

| Scenario | Native hosts | Processes | Private MB | Tab-event IPC/s while browsing | Toolbar dispatch RTT median/p95 |
|---|---|---|---|---|---|
| No Native extensions, before → after | 0 → 0 | 5 → 5 | 314 → 312 | **6.3 → 0** | – |
| 1 legacy (background), before → after | 1 → 1 | 6 → 6 | 337 → 337 | 6.4 → 6.4 (has `vast.tabs.read`) | 0/1 → 1/1 ms (now includes ack) |
| 5 legacy, before → after | 5 → 5 | 10 → 10 | 435 → 434 | 6.4 → 6.4 | 0/1 → 1/1 ms |
| 1 declarative-only (after) | **0** | 5 | 312 | 0 | 0/1 ms (popup) |
| 5 declarative-only (after) | **0** | 5 | 311 | 0 | 0/1 ms |
| Hybrid with static toolbar (after) | **0** | 5 | 312 | 0 | 0/1 ms |
| 20× disable/enable + 5 redundant enables | hosts created **25 → 20**, none leaked (1 host after loop) | | | | |

Each background host costs one renderer process and ~25 MB private memory (legacy5 − none ≈ 121 MB / 5). A declarative extension adds no process and no measurable memory. Event handling latency (click → listener) stayed ≤1 ms median. Startup-to-ready (600–750 ms) and idle CPU (1–8 % of one core, all scenarios) are within run-to-run noise; no difference is claimed.

Bundle: main entry 500 373 → 503 152 B (budget 505 000), initial renderer 1 293 070 → 1 295 314 B, preload 15 849 → 16 032 B, total JS +28.8 KB (mostly lazy chunks). No dependency added.

## 5. Tests

| Command | Result |
|---|---|
| `npm run lint` | pass |
| `npm test` | 1194 pass, 0 fail, 1 skipped (same skip as master) |
| `npm run hub:test` | 24/24 |
| `npm run hub:typecheck` | fails on `tests/hub.test.ts` `'../wrangler.jsonc?raw'`, identical on master (pre-existing) |
| `npm run test:extensions:native-e2e` | pass (adds: declarative extension with no host, verified icon, popup route, acknowledged delivery, no-listener rejection, no restart on redundant enable, host crash cleanup and recovery, no tab-event demand) |
| `npm run test:extensions:e2e` (patched runtime + ECE) | pass (adds: `chrome.contextMenus` item in the Vast page menu, click reaches the service worker, token single-use) |
| `npm run test:adblock:extension-e2e` | pass |
| `npm run test:extensions:native-messaging-e2e` | pass |
| `npm run performance:budget` | pass |

New unit tests: `tests/shared/extension-native-contributions.test.ts`, `tests/main/extension-declarative-lifecycle.test.ts` (approval, revocation, disable/enable, uninstall, restart restore, update escalation, toggle loops, no runtime created), additions to contribution, manifest, compatibility-runtime and security tests, and a Hub validation case.

Not run: `npm run build:obfuscated`, packaged-build benchmarks, managed `.vext`/Hub install E2E with a declarative package (covered by unit tests of the shared parser and Hub validation, not by an Electron run).

## 6. Remaining risks and limits

- `tabs.*` UI-broker requests still go to the focused Vast window; in multi-window use an extension sees and controls only that window's tabs.
- `tabId` and page data in a menu click come from the trusted browser renderer; main validates their schema, not their liveness.
- Acknowledgement means "a listener received it"; asynchronous work started by the listener is not tracked.
- A crashed background is not restarted automatically (no crash loops); Reload restores it.
- `chrome.action.onClicked` for Chrome actions without a popup is still not dispatched; command shortcuts (runtime or manifest) are listed, not bound.

## 7. Future readiness (local translator)

A hybrid MV3 extension can now run without any Native background: a declarative toolbar action opens its Chrome popup in the active persistent workspace, and `chrome.contextMenus` (e.g. a `selection` item) is shown in the Vast page menu and delivered to its service worker in the tab's session. Still needed before such an extension ships through the Hub:

1. Hub policy rejects any `WebAssembly` use (`extensions-hub/src/validation.ts`, AST rule) — a reviewed allowance for local `.wasm` modules is required.
2. MV3 needs `'wasm-unsafe-eval'` in `content_security_policy.extension_pages`; not verified on the shipped runtime.
3. Long-running inference in an MV3 service worker (or an offscreen document) under the patched runtime is unverified.
4. Toolbar activation without a popup (`chrome.action.onClicked`) is not routed.
