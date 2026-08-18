# Vast 1.0.11 production performance audit

## Scope and method

This pass optimizes the existing Electron/React architecture. It does not change the framework, persisted-data schema, browser security settings, private workspace partitioning, popup model, or visual identity.

Measurements come from the obfuscated, packaged Windows x64 application at `release/win-unpacked/Vast.exe`, not the development server. The repeatable harness is `scripts/performance-suite.cjs`; raw process/main/renderer reports and profiles are under `performance-results/`. `baseline.json` was captured before production changes and `final.json` after them. `comparison.json` contains the acceptance calculations.

The suite uses fresh profiles for cold runs and a reused profile for warm runs. It records external launch-to-shell time, exact main-process marks, Chromium paint and renderer metrics, main event-loop delay, renderer long tasks, process memory/CPU, storage bytes/writes/backups, download events/checkpoints, tab switching, close reclamation, bundle files, and 15 create/close lifecycle cycles. Windows process launch and `BrowserWindow` construction have visible run-to-run variance, so startup conclusions use the median of three runs.

## Measured bottlenecks

1. The original release obfuscated every JavaScript bundle aggressively. The initial renderer was 1,705,153 bytes after obfuscation, the main bundle about 639 KB, and total JavaScript 7,438,298 bytes. Parse/execute work was paid before the browser shell was usable.
2. Settings, command palette, side panel, smart unload, and the entire browser stage were part of the initial renderer graph even while hidden.
3. Session restoration treated recently used inactive pages as candidates for immediate guest creation. Restoring 10 to 250 tabs settled near 1.05 GiB even though only one page was visible.
4. A download progress stress run caused 12 full-model durable writes and 12 rolling backups. One ordinary navigation caused four writes. Download progress was live state but flowed through the renderer's general persistence detector.
5. Every durable save performed validation, serialization, an atomic file replacement, and a rolling backup. Rapid saves were serialized rather than collapsed to their newest state.
6. Sidebar rows subscribed to the complete group collection, repeatedly filtered groups, and rerendered on unrelated tab changes. Group assignment was calculated with nested filtering. Horizontal tabs also rerendered because callback identities changed.
7. Repeated autofill injection could leave prior document listeners and a `MutationObserver` alive. Webview event bindings were also recreated by unrelated privacy/spoofing settings changes.
8. Request handlers rebuilt derived policy/spoofing state for every resource request, while popup/spoofing diagnostics used synchronous filesystem calls in the main process.

## Changes implemented

### Startup and production bundling

- Local storage and startup configuration are read without any remote feature check blocking window creation.
- The redundant post-render storage read was removed.
- Updater setup is deferred until after `did-finish-load`, and its module is a separate main-process chunk. Updater controls dynamically load it when needed.
- BrowserStage, Settings, Command Palette, Side Panel, and Smart Unload are lazy chunks. PDF, diagnostics, integrations, Video & Audio, automation, password, reader, network, notes, session timeline, and site data surfaces remain on-demand.
- The opening splash and reduced-motion behavior remain intact. No security flags were weakened and the loading fallback uses the existing dark shell color.
- Release obfuscation is deterministic and selective. The startup shell and preload avoid disproportionate transforms; main/startup code receives a light compact identifier profile; the Passwords chunk retains aggressive protection. The PDF worker and optional noncommercial chunks are not inflated by obfuscation.
- `scripts/check-performance-budget.cjs` enforces initial renderer, main, preload, and total-JS budgets in `build:obfuscated`.

### Persistence and downloads

- Live download progress remains IPC-driven but no longer changes the renderer durable-state token.
- Main owns download durability. In-progress downloads checkpoint at most every 30 seconds; completion, cancellation, interruption, scan/hash completion, and scan failure are persisted reliably.
- A dedicated benchmark counter distinguishes download checkpoints from unrelated storage writes occurring in the same time window.
- Navigation/history/site-memory changes share the 900 ms consolidated save window. The benchmarked ordinary navigation creates one durable write.
- `LatestTaskQueue` collapses rapid queued states to the in-flight state plus the newest pending state.
- Identical serialized data is not rewritten.
- Atomic temp-file replacement, validation, import/restore recovery, and corruption backups remain unchanged.
- Rolling backups are limited to one per minute during normal saves instead of one per mutation; manual, invalid, pre-import, and pre-restore backups retain their existing semantics.
- A normal data save no longer emits the settings-specific broadcast.
- Window close still uses the existing close coordinator and awaits the renderer's final `storage.flush` before closing.

### Tab scalability and lifecycle

- Restored inactive web tabs start as `discarded`; the active and split-view tabs receive priority. Pinned tabs still obey `keepPinnedTabsAwake`, audible tabs remain protected, and disabling hibernation still loads all requested pages.
- A discarded tab cannot be recreated merely because its prior-run `lastAccessedAt` is recent. Activation retains the immediate restoring state already present in the UI.
- Sidebar grouping is calculated once with a tab-to-group map. Tab rows and group sections are memoized, rows no longer subscribe to all groups, and offscreen vertical rows use `content-visibility` with an intrinsic height.
- Horizontal tab components are memoized against tab/group/active/width state, so an unrelated tab update does not repaint every visible tab.
- Guest registration remains map-based, and close/discard unmounts the webview and removes its listeners/media registration. The 15-cycle benchmark finishes with fewer processes than it started with.

### Webview scripts and main-process request work

- Autofill reinjection now invokes an explicit previous cleanup, aborts document/input listeners, disconnects its observer, and removes its DOM/style roots. The behavior is covered by an executable VM regression test.
- Spoofing settings are read through a ref inside stable webview bindings; toggling a setting no longer tears down all guest event listeners.
- Cosmetic ad block and site override scripts retain their existing idempotent style/root IDs. OAuth body probing remains gated by plausible OAuth URLs.
- Per-session request policy and spoofing derivation are cached by the immutable settings reference. Temporary-session tracker behavior, ad blocker modes, HTTPS-only upgrades, Chromium identity headers, and Video & Audio authorization are unchanged.
- OAuth and spoofing diagnostic files use serialized asynchronous appends rather than synchronous filesystem operations on the main thread.

## Before and after

| Metric | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| Cold launch to interactive shell, median | 1,314 ms | 843 ms | **-35.8%** |
| Warm launch to interactive shell, median | 1,351 ms | 732 ms | **-45.8%** |
| Launch to `BrowserWindow` construction, cold median | 301.2 ms | 280.6 ms | **-6.8%** |
| First contentful paint, cold median | 1,676 ms | 1,212 ms | **-27.7%** |
| Renderer TaskDuration at startup, median | 542.6 ms | 262.3 ms | **-51.7%** |
| First active page load start, cold median | 944.8 ms | 923.8 ms | **-2.2%** |
| Restore 250 tabs working set | 1,050.2 MiB | 679.1 MiB | **-35.3%** |
| Restore 250 tabs process count | not isolated in baseline | 8 | inactive pages stay lightweight |
| Switch at 100 stored tabs, active target | 42.0 ms | 30.6 ms | **-27.2%** |
| Switch at 100 stored tabs, discarded target | 74.5 ms | 42.2 ms | **-43.3%** |
| Loaded/sleeping switch at 10 loaded tabs | not recorded | 10-12 ms | visually immediate |
| 25 loaded tabs, before close | 4,690 MiB | 4,588 MiB | -2.2% |
| After closing 20 of 25 tabs | 2,210 MiB / 24 processes | 931 MiB / 10 processes | stronger reclamation |
| 50 deliberately loaded tabs, settled visible CPU | 96.4% | 0% sample | substantial idle reduction; sample is workload/OS sensitive |
| Ordinary navigation durable writes | 4 total-window writes | **1 operation write** | consolidated |
| Download stress durable writes | 12 | **1 download checkpoint** | **-91.7%** |
| Download progress events delivered | 6 | 6 | no UI loss |
| Rolling backups during download stress | 12 | 1 total / 0 during operation | consolidated |
| Total production JavaScript | 7,438,298 B | 5,530,871 B | **-25.6%** |
| Initial renderer JavaScript | 1,705,153 B | 870,489 B | **-49.0%** |

The final cold samples were 843, 739, and 950 ms. Final settled startup observations contained zero buffered renderer long tasks after the shell settle point. Main event-loop p95 remains noisy (typically 30-42 ms because the probe resolution is 20 ms); no synchronous diagnostic writes remain. The native `BrowserWindow` construction submark is variable across runs and is treated separately from the stable end-to-end shell median.

## Acceptance gates

All machine-evaluated gates in `performance-results/comparison.json` pass:

- cold startup improves by at least 25%;
- download checkpoint writes decrease by at least 90%;
- an ordinary navigation produces no more than one durable write;
- a 250-tab restore creates only the active guest process set;
- closing tabs releases memory and processes;
- repeated create/close cycles do not grow the process count.

The 50-loaded-tab test intentionally disables hibernation and therefore remains expensive at about 8.7 GiB. This is not the default lifecycle: with hibernation enabled, the 250-tab session uses about 680 MiB. No RAM limit was increased.

## WebContentsView technical spike

`npm run performance:webcontents-view-spike` creates isolated sandboxed `WebContentsView` instances on Electron 42.3.0. Results are stored in `performance-results/webcontents-view-spike.json`.

| Views | Create and load | Synthetic switch median / p95 | Working set |
| ---: | ---: | ---: | ---: |
| 1 | 165.5 ms | 1.54 / 4.65 ms | 202 MiB |
| 10 | 1,148.6 ms | 2.26 / 3.36 ms | 931 MiB |
| 25 | 2,796.2 ms | 3.41 / 4.90 ms | 2,061 MiB |

The spike shows attractive native attach/switch latency, but it is deliberately synthetic and is not directly comparable to full websites in Vast. A production backend must preserve:

- per-workspace/private sessions and partition ownership;
- navigation, history, title/favicon/loading/media/crash events;
- `setWindowOpenHandler`, native OAuth/payment popups, opener/postMessage, and shared cookies;
- guest-scoped autofill/password capture without exposing app IPC;
- downloads, security scanning, permissions, spoofing, ad/tracker blocking, reader mode, and site overrides;
- split view, bounds/resize synchronization, DevTools, print/PDF, detached/reattached tabs, media controls, and crash restore;
- correct z-order and clipping for side panels, modals, command palette, find UI, drag/drop, and opening animation.

Recommendation: do not merge a full migration in 1.0.11. Continue with a feature-flagged backend adapter and provider/OAuth parity harness. The lower-risk webview changes already deliver the startup and large-session gains, while WebContentsView still carries material input routing, overlay composition, popup ownership, and migration risk.

## Remaining risks and intentionally deferred work

- A loaded page's memory is primarily Chromium/site content. Vast now avoids eager restore and releases closed guests, but it cannot make 50 concurrently loaded independent sites cheap without suspending some of them.
- Authentication/form sensitivity cannot be inferred perfectly. Current protections for visible, split, audible, pinned-configured, and user-activated tabs remain conservative; a future lifecycle service should add explicit page-state protection signals before becoming more aggressive.
- The WebContentsView spike does not claim functional parity and is not enabled in production.
- GPU quality was not globally reduced. Existing blur/visual identity remains; the pass reduces hidden component work and offscreen tab layout instead. More aggressive adaptive blur requires a representative weak-GPU lab because visual regressions would otherwise be speculative.
- Provider OAuth behavior can change independently of Vast. Existing sandboxing, web security, native popup/session behavior, and fallback routing were preserved.
