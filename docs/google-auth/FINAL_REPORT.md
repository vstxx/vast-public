# Google Auth sprint final report

Date: 2026-07-17 (Europe/Warsaw)

## Executive result

Vast-caused OAuth interference has been removed and generic OAuth mechanics are stable. The user reports that Google login works in native Electron auth mode. A clean packaged check did not reproduce a reliable fresh-login pass: the exact-runtime Chromium identity was sent to `/v3/signin/rejected`, while the native Electron input-event check remained on the identifier screen and is inconclusive.

This report does not claim that the successful user run was definitely a fresh complete session, does not claim 90% “Continue with Google”, and does not hide provider rejection behind external fallback.

## Vast-side causes fixed

1. The audited worktree denied Google identity-provider navigation and forced external fallback.
2. Hand-authored UA and Client Hint rewriting could disagree with engine-visible identity.
3. Ad/tracker/HTTPS/spoofing hooks lacked a central auth-sensitive bypass.
4. Auth pages could receive DOM inspection, script injection, cosmetic blocking, autofill detection, site overrides, reader styling or CDP geolocation handling.
5. Direct navigation and popup OAuth did not share one central compatibility policy.

## Implementation

- Central narrow auth compatibility policy.
- Real top-level auth BrowserWindow inheriting the opener session.
- No preload, Node API, nested webview, DOM inspection, reader/cosmetic/site injection, spoofing or CDP in auth.
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true` and insecure content disabled.
- Scoped request-hook bypass only for registered auth chains.
- Preserved `window.opener`, `postMessage`, cookies, callbacks and close behavior.
- Redacted `Logs/google-auth.log` without content, form values, cookies, tokens or account identifiers.
- Production identity remains `native-electron`, matching the user-operated flow that worked. The rejected exact-Chromium profile is only a recorded test variant.
- Test-only email input requires an explicit internal flag and disposable `VAST_TEST_USER_DATA_DIR`; it never accepts a password.

## Verification

- Auth/security policy tests: PASS.
- Deterministic opener/cookie/postMessage/callback harness: PASS.
- Unit suite: 284/284 PASS.
- App smoke: 57/57 PASS.
- Updater suites and release audit: PASS.
- Packaged isolated-profile launch: PASS.
- User-operated native Google login: reported PASS.
- Packaged exact-Chromium fresh email gate: PROVIDER BLOCK.
- Packaged native-Electron email gate: INCONCLUSIVE.

## Success percentages

- Deterministic auth mechanics: 18/18, 100%.
- User-reported direct login: 1/1 reported successful; freshness not independently proven.
- Independently verified packaged fresh completion: zero completed flows.
- Third-party “Continue with Google”: 0/10 executed.

The 90% SSO criterion is not met.

## Decision

**C. Electron does not currently provide evidence of the required Google-auth reliability.**

Electron Vast remains a stable, usable product build and should keep sterile native auth plus limited external fallback. For a guarantee of fresh Google login and broad third-party SSO, the evidence is inconsistent enough that the preserved full-Chromium port is the credible long-term route. Chromium work is not resumed by this report; that requires a new explicit priority decision.

No anti-detection, private Chrome API, imported cookie, Google client secret, disabled security control or further fingerprint chasing was introduced.

