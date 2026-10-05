# Settings, sidebar, startup, and tab lifecycle performance audit

Status: functional fixes, focused tests, and a private-package before/after comparison complete on isolated local fixtures. The installed 0.4.2 package did not yield a valid host/navigation run, as detailed below. The user reports that ChatGPT, Gmail, and page loading feel very fast in manual use of the release-profile candidate. Startup optimization with realistic profiles is a separate next task.

The release-profile native build failed once at `offline_audio_destination_handler.obj` with LLVM out-of-memory while a private candidate package was being assembled concurrently. The package's icon tool also ran out of memory. Native compilation was restarted with `-j 1` after packaging stopped; no timing result from the overlapping period is used here.

## Measurement setup and limits

- Packaged Vast 0.4.2 private parent, approved r5 runtime, disposable profiles, local HTTP fixtures, 1280 × 800 host viewport. No authenticated sites or personal profile data.
- Existing `scripts/host-interaction-benchmark.cjs` measures click-to-DOM insertion and two host `requestAnimationFrame` callbacks. Neither number proves physical presentation or input latency. One three-repetition session per package was run while the native build was stopped.
- New `scripts/tab-reload-audit.cjs` records webContents IDs and a fresh page marker across tab switches and UI actions. This is a functional check and was run while the native build was active; its elapsed time is not a performance measurement.

## Measured baseline

| Path | Packaged parent observation |
| --- | --- |
| Settings, first open | 322 ms to DOM insertion; 518 ms to two host rAF callbacks; 193 ms of observed long tasks |
| Settings, repeat opens | 94–136 ms to DOM insertion |
| Side panel, first open | 317 ms to DOM insertion |
| Side panel, repeat opens | 9–17 ms to DOM insertion |
| Ordinary tab switch | Same guest webContents ID and page marker after A → B → A |
| Settings and side panel | Same active guest webContents ID and page marker after both open/close cycles |
| Manual Sleep, automatic hibernation initially off | Guest changed ID 3 → 4 and page marker changed; automatic hibernation became enabled |
| Manual Deep discard, automatic hibernation initially off | Guest changed ID 2 → 5 on reactivation; automatic hibernation became enabled |

The first four measurements come from `performance-results/host-ui-parent-clean/results.json`. The functional tab observations come from `performance-results/tab-reload-parent-functional/results.json`. The cold/warm split makes lazy chunk loading and first mount plausible contributors. It does not quantify each contributor separately. The repeated Settings cost points to work beyond initial code loading.

## Final packaged comparison (2026-10-04)

The previously packaged **private 0.4.2 parent** and the completed private 0.4.2 release-profile candidate were measured parent/candidate/candidate/parent, with two fresh disposable profiles and three open/close cycles per profile. The native runtime profile, app JavaScript, and package configuration differ: the parent metadata leaves `sourceCommit` empty and enables staging Relay, while the candidate pins its source and disables Relay. This is an end-to-end comparison of these two private packages, **not** a per-change attribution or an exact published-0.4.2 comparison. The machine was not compiling during measurement. All values below are milliseconds. Clicks were programmatic DOM actions; DOM insertion and two host rAF callbacks do not prove physical input-to-display latency.

| Interaction | Parent | Release-profile candidate |
| --- | ---: | ---: |
| Settings, first open to DOM | 320 / 323 | 319 / 307 |
| Settings, first open to two rAF callbacks | 609 / 493 | 359 / 342 |
| Settings, subsequent opens to DOM | 169–186 | 17–28 |
| Sidebar, first open to DOM | 328 / 321 | 307 / 309 |
| Sidebar, subsequent opens to DOM | 16–19 | 3–4 |

The repeat Settings median fell from 177 ms to 20.5 ms; repeat sidebar median fell from 16.5 ms to 3.5 ms. The candidate still incurs about 0.3 s on the first opening of each panel. Settings first-open two-rAF time improved, while first DOM insertion did not materially change. Raw runs: `performance-results/host-ui-parent-release-compare-{a,b}/results.json` and `performance-results/host-ui-release-compare-{a,b}/results.json`.

The completed package passed all six functional tab checks in `performance-results/tab-reload-release-final/results.json`: ordinary A → B → A switching, Settings, and sidebar kept the active guest ID and page marker; manual Sleep did not enable automatic hibernation or reload the sleeping page; Deep discard reloaded only on activation and did not enable automatic hibernation.

Five local guest navigations per package, with HTTP cache disabled and all 48 fanout assets verified on every run, produced these medians:

| Fixture | Parent FCP / DOM interactive / load | Candidate FCP / DOM interactive / load |
| --- | ---: | ---: |
| Simple localhost page | 72 / 53.7 / 54.6 | 28 / 14.1 / 14.3 |
| 24 CSS + 24 JS files | 196 / 76.9 / 294 | 60 / 20.7 / 75.5 |

The figures are renderer Navigation Timing/FCP milestones on localhost, not real-network page loading or screen scanout. Raw results are in `performance-results/guest-load-{parent,release}-final/results.json`.

An additional attempt to use the actually installed 0.4.2 as baseline did not yield valid measurements: the host interaction run timed out in `Runtime.evaluate` on the first Settings opening, and a separate guest-load run timed out waiting for its first local navigation. Their logs are `performance-results/host-ui-installed-042-a.log` and `performance-results/guest-load-installed-042.log`. Neither attempt is included in the tables; the cause was not established.

The guest-load harness now closes Vast gracefully before its forced-kill fallback, allowing the startup probe to flush. Two fresh empty-profile launches per package recorded the first active page's load-start mark at 1107 / 2003 ms for the parent and 705 / 702 ms for the candidate, measured from probe initialization. The parent's second run varied markedly; two samples are insufficient for a stable startup distribution. These are a baseline for the planned startup investigation, not an explanation of startup cost. Reports: `performance-results/guest-load-{parent,release}-startup{,-b}/startup.json`. Extension-bearing profile startup and true process-launch-to-visible-content timing remain to be measured in that task.

## Confirmed source paths and changes under test

- `SettingsModal` is lazy-loaded on first open and mounts all 14 sections. Section search hides rather than unmounts other sections. Its broad subscriptions to whole tab, download, history, and other arrays made the entire modal re-render on transient tab metadata and download progress. The selectors now read only the values rendered by the modal; diagnostic copy actions fetch the current full tab/workspace snapshot on click.
- `SidePanel` is lazy-loaded and mounts its active view. Its cold open has a substantial delay in the baseline, but its warm open is much faster. The active guest remains mounted during panel open/close. A 260 ms close timer inside `SidePanel` could never drive its exit state because `App` unmounts the panel as soon as `sidePanelOpen` becomes false. The dead timer was removed and the conditional return was moved after all hooks. The exit animation remains absent and is a separate UX issue, not evidence of a tab reload.
- The retention controller owned two periodic timers when automatic hibernation was enabled: a 30 s retention clock and a 15 s process-memory query, even with no hidden retained web tab. Settings does not own these timers. The candidate runs both only while such a tab exists and clears them when it disappears or automatic hibernation is disabled. The old manual unload action silently enabled automatic hibernation and backdated both Sleep and Deep discard beyond the discard deadline. The candidate separates these actions, preserves the user's automatic setting, and keeps manually discarded tabs unmounted until selected even when automatic hibernation is off.
- Zustand 5 notifies all subscribers when a setter returns `{}`. Four no-change paths in the store did so, including repeated tab metadata and keep-awake updates. They now return the existing state object. The retention controller now skips repeated keep-awake IPC when the protected tab set is unchanged.
- The retention controller previously rebuilt its protected set, sorted candidates, and reconciled lifecycle after title/progress changes because it depended on the entire `tabs` array. It now reuses the retention input snapshot while ID, URL, status, lifecycle, pin, and access time are unchanged; the browser stage also keeps visible IDs stable across active-tab metadata updates. `WebviewSurface` still receives the current tab object for progress and navigation UI.
- Autosave previously built a joined durable signature for every tab on every store notification, including progress updates. It now compares consecutive states, skips identical tab object references, and checks durable fields only for changed public tabs. Private-tab churn remains excluded. TypeScript and focused tests pass; packaged measurements are pending.
- Ordinary tab switching uses stable tab and webview keys. A guest reload is expected when retention removes its webview, when workspace identity changes the partition key, after a crash/reload command, or when extension loading explicitly reloads matching tabs. The parent functional audit confirmed no reload from ordinary A → B → A switching or opening Settings/side panel in its two-tab local fixture.

## First-load audit

The main process currently awaits startup health, storage loading, browser session security setup, legacy session migration, and extension-manager initialization before constructing the primary browser window. The renderer then loads its saved state and lazily loads the browser stage; a Purist layout also loads its chrome module before hydration. The guest preload makes three synchronous main-process IPC calls at document start for spoofing, privacy, and extension document rules. Session request hooks run before network requests; an applicable blocking extension can defer a request while its background page answers, with a 500 ms provider timeout.

These are candidate costs, not measured root causes. Probe marks were added around session-security setup, extension initialization, and IPC readiness so a packaged startup report can separate the phases. `scripts/guest-load-benchmark.cjs` already provides local simple and 48-asset guest fixtures for an idle-machine navigation comparison; pass `--startupReport=1` to save the startup probe alongside it. No change to security policy or extension behavior was made on the basis of source inspection alone.

## Verification still required

1. The release-profile Electron binary and its security/extension gates passed the checks in [ELECTRON_RELEASE_PROFILE_VALIDATION_2026-10-04.md](ELECTRON_RELEASE_PROFILE_VALIDATION_2026-10-04.md). The user reports a positive manual result for ChatGPT, Gmail, and page loading; instrumented physical-input and authenticated-site timing remains outside this local synthetic audit.
2. First Settings/sidebar opening remains about 0.3 s. A future UX pass can profile lazy chunk evaluation and first mount if this is perceptible to users.
3. The next startup task should measure launch-to-visible-content with repeated empty and extension-bearing disposable profiles and identify the specific phase costs before changing startup order.
