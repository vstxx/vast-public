# Background update audit — 2026-09-09

## Root causes

- Main waits 2 seconds after the primary renderer loads, then the updater waits 8 seconds. The check was real, but `VAST_UPDATE_AUTO_DOWNLOAD` and `VAST_UPDATE_AUTO_INSTALL` both defaulted to false. The renderer nevertheless always announced a background download.
- `checkForUpdates()` completes before `downloadPromise`; the latter was not observed by Vast. There was no retry schedule after an interrupted transfer.
- Reinitialization registered duplicate listeners. Events captured the original window, so closing it or reloading a renderer lost update information. Main and renderer also generated duplicate notifications.
- Explicit installation launched the installer before the normal close/save barrier and bypassed extension/session shutdown. The upstream NSIS process check can terminate other running browsers.
- NSIS uses registered uninstall paths even when passed an explicit destination. A copied or second installation could therefore cause a different registered copy to be removed.

## Implemented path

Eligible installed Windows builds check approximately 10 seconds after shell load. Full NSIS installers download automatically; web installers and downgrades are disabled. Stable builds exclude prereleases. Opt-out environment variables remain available. Microsoft Store retains Store-managed updates.

The existing electron-updater transport verifies SHA-512 and the configured publisher before declaring a download ready. Its native cache validates a previous download on a later check. Vast copies the packaged feed configuration, preserving repository/publisher settings and replacing only the cache namespace with a hash of the installation and profile paths. Separate installs/profiles cannot overwrite each other's pending files. No changes are made to workspace partitions, cookies, vault encryption or durable renderer autosave.

Errors are surfaced and retried with backoff from 1 to 15 minutes. Successful no-update checks recur after 4 hours. A ready Windows download is recorded atomically with its version, exact executable, cache file and verified SHA-512. Renderer subscriptions recover the last event through the existing status IPC; progress is deduplicated by whole percentage and is never written into browser state.

Normal close and **Close and update** both go through the regular renderer persistence handshake, extension shutdown/flush, Video & Audio shutdown and Chromium session checkpoint. Clear-on-exit privacy preferences remain effective. Windows does not start an installer while quitting. Before the next startup loads browser data or creates webviews, a validated pending record hands installation to a hidden external waiter and the old bootstrap process exits. The waiter confirms that exit, verifies SHA-512 again using streaming I/O, waits for the installer, then opens Vast with the original arguments and inherited environment. This also works offline with an already prepared update.

The bootstrap process waits for an explicit helper acknowledgement, rather than merely successful process creation. A blocked, crashed or unresponsive helper leaves the old browser running. Failures are recorded, attempts are bounded to three, and recovery launches skip the handoff once to avoid restart loops. A successful new version removes the pending marker. A later feed check does not reset failed attempts for the same payload. An explicit user retry can reset them. Cache metadata cannot select another installation or a file outside that profile/installation's native cache. Store packages exclude the helper entirely.

The NSIS hook executes before removal/extraction. Silent installation defers if either Windows registration points to a different application directory. It waits up to 30 seconds for Vast processes to exit, then defers with exit code 2 if a process remains or process inspection fails. It never kills them. A subsequent launch can retry the prepared installer offline. These checks are deliberately conservative: a different registered or running Vast installation can also defer the update.

## Boundaries, not guarantees

- Portable executables and loose `win-unpacked` copies are explicitly excluded from NSIS auto-installation. They require their corresponding portable/standalone update path. Automatically feeding them an installed-browser installer would change installation/profile behavior. Automatic in-place updates for those distributions are **not implemented here**.
- A crash or power loss before staging completes leaves the old version usable; partial or malformed metadata is ignored. A fully staged update can be recovered offline on next launch. This is not a claim that a previously unsaved browser session survives every crash.
- Startup waits for its installer before reopening Vast. An unrelated running Vast installation can still force deferral. Recovery is bounded and does not forcibly close other users' processes.
- Renamed executables and profiles located inside the application directory (including resolved junctions) are excluded from automatic NSIS updates, to avoid targeting the wrong binary or removing profile data.
- UAC refusal, antivirus locks, insufficient disk space and interrupted installer execution are not bypassed. No claim is made of power-loss rollback or successful updates under every Windows permission/layout combination.
- Publisher verification follows the packaged feed configuration. An intentionally unsigned release does not acquire Authenticode trust merely through this change. The pinned provider and checksum remain necessary.
- Previously published binaries/installers are unchanged. The new process guard must be included in the next release's NSIS artifact.

## Verification

- Updater orchestration tests cover default behavior, idempotency, isolated cache configuration, deduplicated progress/checks, staging before readiness, opt-outs, retry/recovery and Store/development/portable/unpacked/unsafe-profile policy. Pending-record tests cover offline startup, version acknowledgement, invalid paths/metadata, failed-attempt retention and loop prevention.
- Real Electron + electron-updater fixture: actual local HTTP transfer/progress, a fresh updater instance reusing the cache, corrupt cached bytes, interrupted transfer and retry, SHA-512 rejection, publisher-verification rejection. No downloaded fixture is executed.
- Compiled NSIS fixture: idle install proceeds; a mismatched registered installation blocks file changes; a live test process remains alive and no installation marker is written; retry succeeds after it exits. This tests the production hook, not a mock of it.
- Real PowerShell handoff with compiled executable fixtures: acknowledges readiness, waits for parent exit, preserves URL/space-containing arguments, runs the verified installer before the browser, rejects corruption, records installer failure and reopens without looping. Startup orchestration tests separately verify helper spawn errors, early exit and acknowledgement timeout.
- All 623 Node tests pass; TypeScript and radius lint pass.
- Existing standalone updater and bootstrapper suites pass, including their existing backup/failure cases. These do not constitute a power-loss test of NSIS.
- Production build with selective obfuscation and unchanged bundle budgets passes: initial renderer 1,122,496 / 1,400,000 bytes; main entry 476,895 / 500,000; preload 14,949 / 24,000; total JavaScript 6,706,589 / 6,800,000. These are final sizes, not a freshly measured performance before/after comparison. Full startup/RAM performance and real per-machine/UAC upgrade runs were not repeated for this pass.
- The historical release-audit check now accepts an explicitly documented publication record while preserving its pre-publication evidence matrix. It no longer incorrectly requires the published 0.2.7 report to say NOT READY. No historical blocker was relabelled as passed.

Run `npm run test:updater:background` on Windows after provisioning electron-builder's NSIS tools. Windows CI exercises real downloads; public release workflows additionally run the compiled installer guard after packaging.
