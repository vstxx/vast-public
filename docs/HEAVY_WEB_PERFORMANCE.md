# Heavy-website performance audit (Electron 45, 2026-10-28)

Question: are active heavy websites (Google Earth, WebGL/WebGL2, WebGPU) slowed by
Vast-specific overhead compared with Chrome and a minimal Electron host?

**Short answer: no rendering overhead.** For active tabs, Vast matches Chrome
and a bare Electron host on WebGL, WebGPU, frame presentation, dropped frames,
input latency and Google Earth. Two Vast-specific costs were found and fixed:

- **Worker-pool throttling.** Standard fingerprinting protection reported
  `navigator.hardwareConcurrency = 8`. Workers still saw the real count.
- **History pollution from `history.replaceState` churn.** Each replaced URL
  became a new history entry.

The largest remaining gain on hybrid-GPU laptops is GPU selection. Chrome
behaves the same way, and the choice applies to the whole app, not to one tab.

## Setup

| | |
|---|---|
| Machine | i7-14650HX (24 threads), 32 GB, Windows 11 26200, AC power, Balanced plan |
| GPUs | Intel UHD (drives the 1920×1080 @ 143.9 Hz panel), NVIDIA RTX 5060 Laptop (Optimus) |
| Vast | Packaged, Store route (`scripts/heavy-web/package-bench.cjs`): patched `electron-45.0.0-vast-r1`, hardened fuses, asar integrity. "before" = master `540a443` + probe instrumentation; "after" = this branch. Unobfuscated Store development metadata. |
| Chrome | 156.0.8078.48 (same Chromium build as Electron 45), fresh profile |
| Minimal host | Same patched `electron.exe`, `scripts/heavy-web/min-host`: page in a `BrowserWindow` (`min-window`) or in a full-size `<webview>` (`min-webview`), no flags, preload or request hooks |
| Viewport | 1480×853 CSS px at DPR 1 for every target (Chrome window sized to match) |
| Profiles | Disposable per run. Vast is seeded with a lived-in profile: 1000 history entries and 250 site-memory entries. |
| Order | Every (scenario, target) runs in a fresh process; target order rotates per repetition; 3 repetitions; medians reported |

### Measurements

| Metric | How it is measured |
|---|---|
| rAF cadence | Page timestamps |
| Displayed frames | Trace `Display::DrawAndSwap` per second in the GPU process (actual presentation, separate from rAF) |
| Dropped frames | Trace `PipelineReporter` states per renderer |
| CPU and memory | Per process tree: Win32 CPU times, private bytes |
| GPU busy per adapter | Windows `GPU Engine` running-time counters, keyed by adapter LUID |
| Input latency | Event Timing (input → next paint) |
| Vast host overhead | Host renderer `Performance.getMetrics` |
| Vast main process | Built-in probe (`--vast-performance-report`): profile saves and event-loop delay |

Reproduce:

```bash
npm run performance:heavy-web -- --out=<dir> --targets=vast:before,chrome,min-webview,min-window
node scripts/heavy-web/earth.cjs --out=<dir>
node scripts/heavy-web/probe-gpu.cjs
```

## Confirmed findings

### 1. GPU configuration is identical to Chrome; no software fallback

`scripts/heavy-web/probe-gpu.cjs` checked four things on all four targets:

- Active adapter
- `featureStatus`: `gpu_compositing`, `webgl`, `webgpu` and `rasterization` all enabled; ANGLE on D3D11; passthrough decoder
- The same `--gpu-preferences` blob
- The same 13 driver workarounds

They are identical across all four targets.

Other GPU facts:

- The build-time Performance GPU flags (`ignore-gpu-blocklist`, `enable-gpu-rasterization`, `enable-zero-copy`) are **off in release builds**. `VAST_PERFORMANCE_GPU` is never set, and nothing is blocklisted, so they would not change anything here.
- The `--disable-features` list on the GPU process (`NetworkServiceSandbox`, `SpareRendererForSitePerProcess`, …) comes from Electron itself. The minimal host has exactly the same list.

**GPU selection on the hybrid laptop.** Every target renders on the Intel iGPU, for WebGL and WebGPU. This includes Chrome, and includes `requestAdapter({ powerPreference: 'high-performance' })`. Chromium uses one GPU process with one adapter, so WebGPU `powerPreference` does not reach the RTX here.

### 2. Rendering, presentation and input: parity

Medians of three runs, 8 s windows:

| Scenario | Vast | Chrome | min-webview | min-window |
|---|---|---|---|---|
| WebGL light: rAF fps / displayed per s | 142.5 / 144.0 | 142.5 / 143.4 | 142.8 / 143.9 | 141.7 / 143.4 |
| WebGL GPU-bound (iGPU 97% busy): fps | 68.1 | 68.6 | 65.6 | 65.7 |
| WebGPU 1M particles: fps | 141.6 | 141.9 | 141.2 | 141.1 |
| Dropped frames (trace) | 0–0.7% | 0.4–0.7% | 0.1–0.6% | 0.3–0.6% |
| Input → next paint p95 under WebGL load | 40 ms | 40 ms | 40 ms | 32 ms |
| Host renderer main thread busy (Vast, min-webview) | 0.01% | — | 0.01% | — |

Notes on the Vast-side suspects:

- **Compositing and CSS.** `WebviewSurface`'s compositing CSS (`translateZ`, `contain: strict` on the webview and its ancestors) adds no measurable cost. The host does not produce frames while a page animates.
- **Embedding cost.** The `<webview>` path costs about the same as a plain window. The one difference is 1–2 fps when GPU-bound, and the minimal webview host shows it too.
- **`backgroundThrottling`.** It only affects hidden guests: inactive tabs (`display: none`) and minimized or occluded windows. This matches Chrome's background tabs. Active guests are never throttled.

### 3. Google Earth: parity

Earth flies to Warsaw in 3D. The script then pans in stop-and-go strokes for 12 s. All 12 runs were valid: the camera moved in every run.

| | Vast before | Vast after | Chrome | min-webview |
|---|---|---|---|---|
| rAF fps / p95 / p99 | 94.6 / 20.6 / 20.9 ms | 94.7 / 20.6 / 20.9 | 96.1 / 20.8 / 21.0 | 91.8 / 20.8 / 20.9 |
| Displayed frames per s | 91.0 | 90.4 | 91.6 | 89.9 |
| iGPU 3D busy | 72.5% | 72.5% | 67.8% | 73.4% |
| CPU (% of one core) | 140 | 150 | 133 | 143 |
| DOMContentLoaded / network quiet | 1145 / 3781 ms | 1076 / 4505 ms | 1063 / 3794 ms | 1043 / 3479 ms |

What limits Earth here:

- **Rendering.** Earth is bound by the iGPU and its own frame loop: about 50% of vsyncs miss everywhere. No main-thread long tasks were recorded.
- **Loading.** Loading is network-bound (14–34 MB, CDN variance), and all targets are within noise.
- **Worker count.** Earth's pan smoothness did not change when `hardwareConcurrency` went from 8 to 24.
- **URL updates.** Earth writes the camera with `history.pushState`, once per camera stop (about 0.3/s), not continuously. This costs the host 0.4% and causes 3 profile saves per 12 s.

### 4. Vast-specific cost: `hardwareConcurrency = 8` in Standard protection (fixed)

Standard fingerprinting protection redefined `Navigator.prototype.hardwareConcurrency` as 8 in the page's main world. Workers still reported 24 (see `probe-gpu.cjs`), so:

- the protection hid nothing,
- the main world and workers disagreed (a detectable signal),
- every page sizing a worker pool from it used 8 workers on a 24-thread CPU.

The fixed CPU job used is 192 chunks, with the pool sized from `navigator.hardwareConcurrency`:

| | before (pool 8) | after (pool 24) |
|---|---|---|
| Interleaved A/B, idle machine | 8.94 s | **5.68 s (−36%, 1.57×)** |
| First survey, machine in use (Chrome 13.1 s) | 41.5 s | — |

**Fix:** Standard leaves the value native. Strict (8) and Maximum (4) keep masking it, as profiles the user opts into. Their worker gap is noted under hypotheses. Code: [fingerprinting.ts](../src/shared/fingerprinting.ts).

### 5. Vast-specific cost: `replaceState` churn rewrote history (fixed)

Every same-document navigation does three things:

- calls `updateTab`,
- adds a history entry (in a list capped at 1000),
- upserts site memory and schedules a full-profile save (about 1 per second).

A page calling `replaceState` at 10 Hz filled about 150 of the 1000 history entries in 15 s. It would push all real history out in under two minutes.

**Fix:**

- The main process compares `navigationHistory.length()` and `getActiveIndex()` around each same-document navigation. When they are unchanged, it reports `replacedUrl`.
- History then rewrites that entry instead of adding a visit.
- The URL a page was opened at is never rewritten, so a page leaves at most two entries.
- `pushState` (Earth, SPAs), back/forward and cross-document navigations are unchanged.

Code: [guest-navigation-entries.ts](../src/main/guest-navigation-entries.ts), [guest-runtime-events.ts](../src/main/guest-runtime-events.ts), and `addHistoryEntry` with `replacesUrl`.

| `replaceState` 10 Hz scenario | before | after |
|---|---|---|
| Fixture entries in the 1000-entry history | 146–151 | **2–3** |
| Frames (fps / displayed) | 142.6 / 144 | 142.6 / 144 |
| Host main thread busy | 6.2% | 6.0% |
| Profile saves in 8 s | 8 (52.9 ms main) | 8 (52.9 ms) |

This fix protects history. It does not save CPU: per-event host work (address bar, tab state) is unchanged, and so is save frequency. Frames were never affected.

### 6. Request interception: mostly structural

A localhost tile flood: 2000 × 2 KB requests, 24 in flight. 12 runs per target, medians:

| | requests/s | p95 latency |
|---|---|---|
| Chrome | 4161 | 6.7 ms |
| min-webview | 4386 | 6.5 ms |
| min-webview + 3 pass-through `webRequest` listeners | 3592 (−18%) | 7.5 ms |
| Vast | 3147 (−28%) | 8.5 ms |

How the cost splits:

- **Electron's `webRequest` proxy:** about two thirds. It exists while any listener is registered, so it is the price of tracker blocking, header normalization and cookie policy.
- **Vast's own JS:** about 40 µs per request. Real tile traffic runs at hundreds of requests per second, so that is well under 1% of a core.

Not changed, because it is security code. See the recommendations.

### 7. Upper bound for a "high-performance" mode: the discrete GPU

This measures the minimal host with Windows' per-app GPU preference set to high performance. The preference was set temporarily for the benchmark `electron.exe` only, then removed.

| | Intel UHD (default) | RTX 5060 |
|---|---|---|
| WebGL GPU-bound fps | 65.3 | **144 (vsync cap; 3D 15.5% busy, copy engine 13.5%)** |
| WebGL light fps | 140.6 | 144 |

`--use-adapter-luid` does not select the RTX under Optimus. A malformed value falls back to software compositing.

## Hypotheses (not established)

- **Strict and Maximum protection.** They still mask `hardwareConcurrency` only in the main world. Workers expose the real value, so these profiles are less effective than they look, and they cap worker pools. Consider either masking it in workers too or leaving it native.
- **Vast's per-request JS.** It calls `webContents.fromId(...).getURL()` and parses URLs 3–4 times per request across the three hooks. Memoizing these per request could recover part of the 12% JS share. Expected real-world gain: small.
- **Continuous `replaceState` on real sites.** Some map or video sites rewrite the URL continuously. They would still trigger about 1 profile save per second. If that shows up in real use, delay saves for same-document-only changes.
- **Battery power and the dGPU.** Not measured. With the dGPU, the cross-adapter copy to the Intel-driven panel costs copy-engine time, plus wake latency.

## Limitations

- **One machine and one display path:** iGPU at 144 Hz, AC power. No other hardware or power states were measured.
- **Background noise.** The user's installed Vast, a Vast test session and VS Code were running throughout. The first worker survey ran while the machine was in use; the A/B ran on an idle machine.
- **Occlusion flag.** The harness runs every target with `--disable-features=CalculateNativeWinOcclusion`. Windows occlusion tracking had marked a focused, topmost window hidden, which stopped its frames. The flag only disables that heuristic; rendering and presentation are untouched.
- **Earth is live content.** Promotional dialogs and A/B variants differ between runs and user agents; Vast's UA includes `Vast/` and `Electron/`. Runs where the camera did not move are excluded. Interaction-phase network bytes are not reported: Earth fetches tiles from workers, which the page target does not see.
- **Event-loop delay** uses a 20 ms timer on Windows' ~15.6 ms granularity. The p99 floor is about 32 ms everywhere, so it only shows large stalls.
- **The minimal host** uses the patched runtime without fuses. The "before" build includes the probe instrumentation, which is behavior-neutral and only active with the report flag.

## Recommendations, ranked

1. **Done: native `hardwareConcurrency` in Standard protection.**
   - Gain: about 1.6× on worker-parallel work on this CPU.
   - Removes a detectable fingerprinting inconsistency.
   - Risk: low.
2. **Done: collapse `replaceState` churn in history.**
   - Protects user history from map and video apps.
   - No performance change.
   - Risk: low; `pushState` and back/forward are unaffected.
3. **Next, if heavy 3D sites matter: an opt-in, app-wide "High-performance graphics" setting** (Windows GPU preference for Vast).
   - Gain: about 2.2× or more on GPU-bound WebGL on this laptop.
   - Requires a restart; uses more power.
   - Chrome's default is the same iGPU, so the current behavior is not a regression.
4. **Optional: memoize per-request lookups in the three `webRequest` hooks.**
   - Gain: at most about 12% on request floods; negligible on real sites.
   - Do it only with tests, because this is security-sensitive code.
5. **Not recommended:**
   - Aggressive Chromium flags. GPU features are already fully enabled, and no blocklist entry applies.
   - Disabling background throttling. Active tabs are not throttled.

### Per-tab Intensive Browsing: assessment

A per-tab mode would add little:

- The active tab already renders at parity with Chrome and a bare host.
- Vast's host costs about 0% while a page animates.
- The one big lever, the discrete GPU, cannot be per-tab: Chromium has one GPU process and one adapter, and WebGPU `powerPreference` is not honored here.
- Per-tab options that remain (unthrottling background tabs, pausing host bookkeeping) target costs measured as nil, or trade battery for no visible gain.

Prefer recommendation 3, together with the existing Smart Unload for memory pressure.
