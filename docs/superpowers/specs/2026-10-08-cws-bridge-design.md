# Vast CWS Bridge — architecture, implementation contract and release gates

**Date:** 2026-10-08
**Baseline:** `vstxx/vast@1964c8f4d6ec4f7e0ae9add95fdcbf5b87309f6f` (Vast 0.4.3; `electron: 44.3.0` in package.json).
**Status:** Design and URL-parser preparation only. **No Chrome Web Store runtime support has been enabled.**
**Safety rule:** Never remove or weaken the current CWS top-level navigation guard until the exact distributable, *patched Electron build* passes the crash gate. No changes to master, release bundles, or existing iCloud distribution are permitted in this preparation branch.

## Why the original crash happens

The local September 15 incident report (`audit/incidents/2026-09-15-webstore-crash/report.md`) records Windows `0xC0000005` browser-process termination while loading an extension detail page. Its symbolized instruction was `extensions::MessageService::OpenChannelToExtension + 0x39d`. The independent September 16 no-extension stock-Electron harness recorded the same Windows exception at `extensions::WebstorePrivateGetReferrerChainFunction::Run + 0x3d` in four CWS scenarios. These are *different crash sites*: do not claim that one fix proves both resolved.

Electron upstream PR #53752 describes an unimplemented `WebstorePrivateAPIDelegate` exposed to store pages by the Chromium 152 roll. Its 44-x-y backport (#53776) was released in Electron **44.4.0**, September 15, 2026. The repository still specifies Electron 44.3.0 and uses a custom-built runtime, so the upstream patch cannot be assumed present. Even after applying it, the stock Chrome Web Store's native `Add to Chrome` flow remains unsupported by Electron. The purpose of this Bridge is to implement an independent, explicit **Install in Vast** path.

Sources:
- https://releases.electronjs.org/pr/53752
- https://releases.electronjs.org/release/v44.4.0
- https://www.electronjs.org/docs/latest/api/extensions
- https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto

## Product contract

1. User visits a real `https://chromewebstore.google.com/detail/.../<id>` listing in a normal Vast tab; search, descriptions, reviews and developer links display normally. Legacy `https://chrome.google.com/webstore/detail/.../<id>` links are supported.
2. Vast-controlled browser chrome (not a forged Google control) displays **Install in Vast** only when main process confirms the active tab's committed HTTPS store URL and parsed extension ID. Optionally render a visually distinguished Vast-owned in-page overlay, but do not depend on Google's DOM structure or impersonate Chrome/Google. The Google button is not wired into a privileged IPC path.
3. On click, a main-process-only operation fetches the official upstream package metadata and CRX, verifies origin and integrity/signatures, then produces a normal Vast permission + compatibility preview. No silent install.
4. The user explicitly approves requested Chrome/host permissions. Native Vast permissions are always empty for CWS content; unsupported APIs do **not** receive grants. Inform the user about partial compatibility, do not refuse solely because an optional API is absent.
5. The extension is installed transactionally using the existing versioned managed store, loaded across eligible persistent workspace partitions, and recorded as `source: 'cws'`. It is **not** silently converted to a Hub publisher or an `official` Vast extension.
6. Runtime activation failure, crash-loop or broken update must leave the app bootable: automatically disable/quarantine the offending extension and restore the last known-good version if available; preserve install diagnostics without private browsing data.
7. Version updates use the same source and verified identity, never change channel without explicit user choice, cannot downgrade/replay, and require fresh approval on permission escalation. Failures keep the old working version.

## Modules and integration points

| Responsibility | Existing building block | Target changes |
| --- | --- | --- |
| Store URL identity | `src/shared/top-level-navigation-policy.ts` | New `src/shared/chrome-web-store.ts` parser (delivered in this branch); keep navigation guard unchanged until crash gate passes |
| Native crash | `package.json`, `experiments/electron-44-patches/`, extension compatibility scripts | Rebase the pinned *source-built* runtime on Electron >=44.4.0 (or apply the exact equivalent security patch), resolve patch queue, validate both symbolized crash signatures in isolated tests |
| Trusted installer | `src/main/extensions/icloud-upstream.ts` | New general-purpose `cws-upstream-client.ts`. Do **not** broaden iCloud's allowlist-only parser as-is |
| CRX3 verification | `icloud-upstream.ts`, `vext-format.ts` | Dedicated `crx3-verifier.ts`: bounded binary/protobuf reader, cryptographic proof verification and expected ID, signed archive, secure ZIP validation |
| Staging / identity | `extension-managed-store.ts`, `extension-manifest.ts` | New `cws` package source; stage verified CRX3 using existing transaction, preserve original Chromium ID via verified key, no fabricated publisher verification |
| Consent | `extension-manager.ts`, `extension-marketplace.ts`, `src/main/ipc/extensions.ts` | `prepareCwsInstall`, `confirmCwsInstall`, `cancelCwsInstall` with expiring one-use install tokens, exact permission matching and compatibility report |
| UI | `src/preload/index.ts`, renderer browser chrome/extensions UI | In-tab Vast-owned Install CTA, existing preview dialog, permissions, optional API warnings, installed/update states |
| Load / lifecycle | `extension-manager.ts`, `extension-compatibility.ts` | Reuse patched-Electron + ECE runtime; compatibility findings measured per runtime, not assumed from manifest alone |
| Updates / recovery | `extension-registry.ts`, managed store, startup recovery | Per-source updater, background check with bounded cadence, atomic commit, crash quarantine |
| Tests | `tests/main`, `experiments/extension-compatibility-spike` | Parser, signature, redirect, consent, update, failure and actual packaged-Windows regression matrix |

## Cryptographic and network contract (blocking)

- Only 32-character `[a-p]{32}` IDs obtained from a committed allowlisted store URL or deliberate user-provided CWS ID. A renderer-provided ID is **not** proof of origin, authority or approval.
- Download from Google's documented Chrome Web Store update service using explicit `https://clients2.google.com/service/update2/crx` metadata and allowlisted Google-controlled HTTPS CRX hosts. Never fetch arbitrary `codebase` or `update_url`, and reject cross-origin or protocol downgrade redirects unless independently policy-validated against the exact allowlist.
- Request metadata/package without browser session cookies or authentication tokens. Strict response limits, deadlines and cancellation; XML parsed without DTD, entities or external resolution (never regex-only in security-sensitive parser). Reject oversized, decompression-bomb, symlink, path-traversal, case-fold collision, duplicate and nonregular entries; extract in quarantined staging.
- Verify CRX3 header limits, signed_header_data, cryptographic RSA/ECDSA proof(s) over the precise `CRX3 SignedData\\0` framed payload, the signed CRX ID, and expected store ID. The signer's public key must cryptographically match the ID; an embedded key hash alone is **not** signature verification. Establish a verifiable store-distribution trust chain before giving the package any `store verified` identity. TLS and signed update-metadata hash are additional integrity controls.
- Do not accept untrusted/unsigned `manifest.key` as evidence of publisher identity. For a valid CRX missing a manifest key, derive it from the **verified** signing public key *only in the unpacked runtime copy*, record this transformation and require unchanged runtime ID. No modification of extension JS.
- No extension may request `vast`, `vast_network` or `vast_document_rules` from CWS. Keep `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, private-workspace exclusions and native IPC sender checks intact.
- No generic file or network proxy exposed to web pages; do not bridge Google page JS to Node directly. The trusted renderer sends an intent, main process recomputes the active webContents' URL, and confirmation uses one-use token+immutable preview.
- Don't let a low-compatibility extension claim success merely because `loadExtension` resolves; report `installed`, `loaded`, and `functional` separately.

## Gate A — Native CWS crash safety

1. Pin exact Electron binary fingerprint and Chromium version for development and production. Rebase the existing Electron patches onto >=44.4.0 or cherry-pick and audit the upstream backport **into the custom source build**.
2. Run isolated, separate-process, zero-extension CWS page loads **after Google consent** (consent landing alone is not a CWS test), with Crashpad dumps and 30-second survival/exit checks.
3. Run same URL with ECE, managed adblocker, MV2/MV3 fixtures, multiple persistent partitions, fresh/restored tabs, new-window and navigation-redirect paths.
4. Match the previously observed `MessageService` and `WebstorePrivate` faults separately; no claim of complete resolution without evidence. Test crash-loop recovery independently.
5. Only if all checks pass, gate browser CWS navigation by **runtime verified capability** (compile-time or trustworthy signed runtime fingerprint), *not* by UA spoofing, arbitrary environment flags in release, or pathname alone. If verification fails, current unsupported page remains in place.

## Gate B — Acquisition, verification, staging

- Mock update responses: success, no-update, wrong ID, wrong version, 404, TLS failure, timeout, spoofed origin, redirect escape, invalid XML, compressed-bomb, corrupt ZIP.
- CRX3 fixtures: valid signature, modified ZIP after signing, wrong key, mismatched signed data, malformed protobuf, oversized header, manifest key mismatch, duplicate entry and symlink.
- Never stage a package or enable its permissions when proof verification fails.
- Reuse existing `ExtensionManagedStore` 3-version retention and rollback, extending its discriminated source types carefully (no changes to Hub/iCloud/Chromium import behavior).

## Gate C — Permission and incomplete-compatibility UX

- Install from modern/legacy CWS listing; one-click request from **Vast-owned** CTA, not Google's native Chrome API.
- Preview extension name/version, source, requested API/host permissions, compatibility categories and known limitations.
- Unimplemented **noncritical** APIs yield a warning; missing or unsafe execution entry points yield disabled/unsupported state. Never auto-grant optional permissions.
- Reject duplicate IDs from other distribution channels without an explicit migration/replace UI and data safety checks.
- Test clickjacking, malicious web page presenting a fake store URL, stale tab switch, reload between prepare and confirm, parallel intents, stale token and changed package/permissions.

## Gate D — Runtime correctness and resilience

- Test at least: one no-permission MV3 extension; uBlock Origin Lite/DNR; IDU+; Bitwarden; Proton Pass; iCloud Passwords; an extension using unsupported `chrome.sidePanel`/nativeMessaging API; and a malicious fixture.
- Separate `installed` from `loaded` from `functional`. Empty extension ID/invalid manifest is a hard error; partial API support alone isn't.
- Verify ECE permissions, service worker wake, `runtime.onInstalled`, `onStartup`, alarms, tabs, popup, requests, action button, declared host matching and multi-extension isolation.
- Preserve Vast's composed `session.webRequest` security ordering and session isolation, including redirect and WebSocket checks. Do not replace Vast's app webRequest listener to appease an extension.
- Browser must boot after crash, rollback from failed update, recover offline and let user disable/remove without losing unrelated extensions.

## Gate E — Update & packaging

- Separate managed `cws` update channel; original signed ID and origin pinned, monotonic version. Incrementally activate; rollback on startup/health failure; no unattended new permissions.
- Direct updater and Microsoft Store MSIX builds must include the exact verified Electron patch runtime; validate GPL source correspondence and notices.
- Performance budgets: no blocking network fetch during UI navigation or startup. No polling for updates on every page visit; cap concurrency/storage/timeouts.
- Review current Google Web Store usage terms and extension licensing before shipping arbitrary-store redistribution or automated download at scale. Avoid promising perpetual access to undocumented Google endpoints.

## Work breakdown / recommended sequence

**P0 — baseline:** lock commit SHA, custom-runtime fingerprint, upstream Electron crash fix; reproduce in disposable profiles. No CWS access on existing stock 44.3.0.
**P1 — cryptography:** implement and independently test general CRX3 signed-payload verification and secure downloader.
**P2 — transactional installs:** add CWS install source/metadata and exact consent, reusing existing manager/staging/rollback.
**P3 — UI:** add accurate Vast-owned install affordance to real CWS listing tabs with progress/errors and compatibility warnings.
**P4 — update/recovery:** enable crash quarantine, update checking, permissions diff, backoff and rollback.
**P5 — release gates:** packaged-Windows canary, MSIX and direct updater validation, regression suite, security review, legal/distribution review.

## Hard release criteria

- Zero native browser-process CWS crashes in the *final patched distributable* under all tested paths.
- Invalid/mis-signed CRX never reaches extraction/activation.
- No unapproved host/API/native privileges; disabled/private partitions remain isolated.
- Partial-compatible extensions install and can be managed without false functionality promises.
- No regression to existing Hub, iCloud, local Chromium import, built-in adblocker, other extensions, upgrade or rollback.
- Chrome Web Store network acquisition remains resilient to expected external endpoint or response changes and fails closed when integrity cannot be verified.
- No silent change to `master`, production CWS gate, release pipeline or user profiles as part of preparatory work.
