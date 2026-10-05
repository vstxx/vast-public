# Guest scrolling after the r5 release-profile build (2026-10-04)

## Manual user result (2026-10-04)

The user ran the isolated candidate under the J Nowa Windows account and reported that ChatGPT, Gmail, and page loading felt very fast after the changes. This is positive real-use acceptance feedback for those paths. No timing log, input-device detail, side-by-side 0.3.0 comparison, or independent capture accompanied the report, so the residual synthetic nested/virtualized callback difference and physical scanout remain unquantified in real use.

## Residual-gap audit (2026-10-04)

The earlier valid, fixed-18-ms trace runs were re-analysed for the two residual fixtures. In the nested scroller, 0.3.0 and the candidate both presented 90 / 90 input-related updates in the first run; the second showed 89 for 0.3.0 and 90 for the candidate. Every presentation matched a `ScrollJankV4` start and a Viz `Display::FrameDisplayed` timestamp. The candidate's guest rAF P95 remained 13.8 ms versus 7.1 ms in 0.3.0, yet the trace does not show fewer nested scroll presentations. The candidate had zero Chromium-janky updates in both runs; 0.3.0 had one in its second run.

The virtualized fixture had 90 / 90 presentations in 0.3.0 and 77 / 76 in the candidate, again with every presentation matched to Viz. This is a real trace difference, but the input distributions were not identical: although all four runs sent 90 commands and 9000 total delta over approximately 1.6 seconds, median guest wheel-arrival intervals were about 14 ms in 0.3.0 and 20.8 ms in the candidate. That difference, plus normal event coalescing, prevents attributing the presentation-count gap solely to rendering throughput. The candidate's virtualized `ScriptDuration` and `LayoutDuration` were lower than the published testing-profile 0.4.2 package and similar to or below 0.3.0, so this fixture does not show a remaining script/layout CPU bottleneck.

The harness now accepts a diagnostic `--cadence-ms` for its fixed-cadence mode and rejects a guest whose visibility state is hidden. A 30 ms control completed on 0.3.0. Its first candidate attempt timed out; the retry received all wheel delta but its guest was hidden and rAF throttled to approximately 1 Hz. A further `Page.bringToFront` attempt still found the candidate guest hidden. None of these candidate 30 ms runs is a valid performance comparison. The earlier 18 ms traces and positive manual feedback support leaving the residual callback gap as a monitored synthetic finding. They do not prove that no display refreshes are missed, and they do not justify a speculative production change.

## Result and scope

The private, unsigned Vast 0.4.2 candidate at `release/win-unpacked/Vast.exe` restores the **synthetic SPA fixture** to Vast 0.3.0-level guest callback cadence and input-to-compositor-presentation latency. The published 0.4.2 package is substantially slower on that fixture. The release-profile build does **not** restore the 0.3.0 guest `requestAnimationFrame` cadence on the nested-scroll and virtualized-list fixtures. No authenticated Gmail or ChatGPT session, physical wheel/touchpad input, or monitor scanout was instrumented. The user has since reported a very good manual result on ChatGPT, Gmail, and page loading. The synthetic benchmark and manual feedback support the remediation; neither alone is release clearance.

The package provenance and non-performance release gates are in [ELECTRON_RELEASE_PROFILE_VALIDATION_2026-10-04.md](ELECTRON_RELEASE_PROFILE_VALIDATION_2026-10-04.md). The earlier, testing-profile investigation is in [guest-scroll-regression-investigation.md](guest-scroll-regression-investigation.md). The release candidate uses Vast r5 Electron 44.3.0 native source with `//electron/build/args/release.gn`: `is_official_build=true`, `dcheck_always_on=false`, PGO phase 2, ThinLTO and the V8 builtins profile. Its native `electron.exe` SHA-256 is `b40c3bd45dfe47bafd77b96e3084692f0494dd4ff3ddb0eac4d7031a60c7b9d7`; the packaged `Vast.exe` SHA-256 is `c979569695baa0abd2af8c3cbfa38e2ca659666a216673be510f5964d5d68c92`.

## Comparable-input method

The previous `cdp-wheel` harness awaited each DevTools acknowledgment before its 18 ms pause. A slower browser therefore received a slower input stream. The new `--input-mode=cdp-fixed` schedules 90 guest-target CDP `mouseWheel` commands at absolute 18 ms offsets without serially waiting for acknowledgments. It records the actual send and guest arrival intervals. Chromium can coalesce wheel callbacks, so success requires total observed `deltaY=9000` and final `scrollTop=9000`, rather than exactly 90 JavaScript wheel callbacks. Every completed result below met both requirements. Dispatch of 90 commands spanned approximately 1.59–1.61 seconds in the package comparison. The display was configured near 144 Hz (Windows reported 143 Hz); the harness used `--refresh-hz=144`.

The benchmark used local long-text, DOM-updating SPA, nested-scroll, and virtualized-list pages in a 1280×800 Vast window with an isolated disposable profile, no installed extensions, GPU enabled, and updates disabled. Package runs were interleaved rather than all of one version at once. Raw JSON and Chromium trace files are under ignored `performance-results/scroll-fixed-*`. The benchmark script and trace parser are `scripts/guest-scroll-benchmark.cjs` and `scripts/guest-scroll-metrics.cjs`.

`guestRafIntervals` is the guest renderer's callback spacing. `ScrollJankV4` starts were matched to `Presentation` events by process and trace ID with FIFO handling for reused IDs. In all six SPA AB/BA traces, every scroll presentation matched a start and shared a timestamp with a Viz `Display::FrameDisplayed` event. Thus the latency is input arrival to a GPU compositor display event, **not** verified physical monitor scanout. The trace cannot count refreshes missed at the screen. CDP mouse-wheel commands are not a physical wheel or precision touchpad.

## Package measurements

Each cell below gives two separate repetitions. Times are milliseconds; P95 describes samples *inside each run*, not confidence intervals across the two runs.

| Fixture and metric | Vast 0.3.0, Electron 44.1 | Published 0.4.2, r5 testing profile | New 0.4.2, r5 release profile |
| --- | ---: | ---: | ---: |
| SPA: guest rAF interval P95 | 7.1 / 7.1 | 20.8 / 20.8 | 7.1 / 7.1 |
| SPA: input-to-presentation P95 | 13.08 / 13.17 | 27.41 / 26.79 | 12.82 / 12.73 |
| SPA: presented scroll updates | 89 / 89 | 71 / 73 | 90 / 90 |
| SPA: Chromium janky updates | 0 / 0 | 1 / 1 | 0 / 0 |
| Nested: guest rAF interval P95 | 7.1 / 7.1 | 13.9 / 13.9 | 13.8 / 13.8 |
| Nested: input-to-presentation P95 | 6.19 / 18.86 | 15.23 / 15.58 | 13.32 / 13.29 |
| Virtualized: guest rAF interval P95 | 7.1 / 7.1 | 14.0 / 14.0 | 14.0 / 14.0 |
| Virtualized: input-to-presentation P95 | 6.47 / 6.49 | 12.83 / 12.74 | 26.73 / 13.37 |

The text fixture produced 7.1 ms guest rAF P95 on all three packages in its single completed run per package. The virtualized candidate's first latency run was an outlier relative to its second run and the further diagnostic controls; the data do not support calling it a stable latency regression. The nested 0.3.0 latency also varied markedly, including one Chromium janky update in the second run. The 0.3.0 SPA delivered 9000 total wheel delta in 89 JavaScript callbacks because of coalescing; all other SPA runs delivered the same delta in 90 callbacks.

The SPA fixture repeatedly evaluates `.row:nth-child(50n)` on a long sibling list. In the old r5 testing profile, `DCHECK_ALWAYS_ON=1` makes Blink's cached `NthChildIndex` assertion recompute an uncached index for each check. The release profile omits this assertion and also changes PGO/ThinLTO/V8 optimization. The measured SPA `ScriptDuration` fell from about 0.48 seconds per run in published 0.4.2 to about 0.017 seconds in the candidate, similar to 0.3.0's 0.018 seconds. The data establish the release-profile **combination** as the fix for this synthetic path; they do not apportion all improvement among the changed GN flags, nor show that authenticated sites execute this selector workload.

## Residual nested and virtualized cadence

The new r5 package and a diagnostic stock Electron 44.3.0 runtime with 0.4.2 app resources both showed about 13.8–14 ms guest rAF P95 on nested and virtualized pages. Therefore these remaining callback gaps are not unique to the r5 native patchset or its release profile. Setting the Vast diagnostic `VAST_DISABLE_BACKGROUND_THROTTLING=1` made no meaningful difference: nested stayed 13.8 ms and virtualized 14.0 ms in two runs each.

To test an app-source contribution, stock Electron 44.1.0 launched the *current 0.4.2 source app* from this checkout. It had the same 1280×673 guest viewport as the packaged comparisons, accepted all 9000 wheel delta, and reproduced nested 13.8 / 13.7 ms and virtualized 14.0 / 14.0 ms across two runs. This is an unsupported version combination and a diagnostic, but it indicates that the version jump alone is insufficient to explain the 0.3.0-to-0.4.2 gap. The app-level cause has not been isolated. A minimal webview host did not provide a clean version control: its initial 44.1 guest viewport was only 150 px high after resize; later CSS-grid attempts changed the viewport but yielded incomplete or untraceable scrolling. Its timing results are excluded from causal attribution. A second diagnostic hybrid, a stock 44.3 package with a 0.3.0 ASAR, lost much of the sent wheel delta and is likewise excluded.

The trace's 76–78 virtualized presentations for 90 wheel commands show that wheel updates can combine. A roughly 14 ms rAF interval alone does not prove that half of actual monitor refreshes were missed or that a person will perceive stutter. It remains a measurable callback difference to investigate, particularly because the same page in packaged 0.3.0 produced about 7 ms.

## Acceptance work still open

1. The user has manually tested the isolated candidate and reported very fast ChatGPT, Gmail, and page loading. If a specific nested or virtualized page still feels slow, record its input device and speed, and compare it with 0.3.0. The unattended Win32 `SendInput` attempt stopped before sending input because Windows refused foreground activation; no instrumented physical-input result was produced.
2. If a person later reproduces a nested/virtualized slowdown, profile host compositing and guest scheduling with matched guest viewport and a verified visible, focused window. Check actual presentation timing with an external capture method if a display-level claim is needed. The current CDP and Viz evidence does not provide monitor scanout.
3. If such a manual regression persists, isolate the responsible 0.3.0-to-0.4.2 app change with controlled app-source bisection or targeted host-rendering probes. Avoid drawing a production conclusion from unsupported Electron/app hybrids or backgrounded runs.

No installed Vast, production user profile, private web content, or signed/public release was changed by these measurements.
