# Electron 1.0.11 Google-auth baseline

Baseline date: 2026-07-17 (Europe/Warsaw)

This baseline was captured before the Google Auth Compatibility Mode implementation. It describes the dirty main worktree exactly as found; no Electron change was reset or discarded.

## Runtime

- Vast: `1.0.11`.
- Electron dependency and installed runtime: `42.3.0`.
- Embedded Chromium: `148.0.7778.180` (`process.versions.chrome`).
- Embedded Node: `24.15.0`; host Node used by scripts: `24.18.0`.
- Host: Windows x64.
- Main window security: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`.
- Release audit confirms those controls remain enabled.

## Session and partition model

- A normal renderer `<webview>` does not set a partition. It therefore uses Electron's persistent `defaultSession`.
- A private workspace webview uses `temporary:<workspaceId>` and is non-persistent.
- `persist:vast-default` exists as `VAST_DEFAULT_WEBVIEW_PARTITION`, but it is only a fallback when an OAuth popup has no opener session. It is not the normal-tab partition in the current renderer.
- A popup created from a webview explicitly receives the opener's `Session` object. This preserves normal-profile cookies for normal tabs and the temporary session for private tabs.
- The E2E harness confirms a popup and its opener observe the same test cookie.

## Browser identity before this sprint

With spoofing disabled, startup still constructs a manual Chromium identity from the exact embedded Chrome version:

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.180 Safari/537.36
```

The default identity intentionally removes `Electron/42.3.0`. `session.setUserAgent()` applies that UA to the default and newly created sessions. In addition, every outgoing request passes through `onBeforeSendHeaders`, which removes native UA Client Hint headers and writes manual values, including:

- `Sec-CH-UA: "Chromium";v="148", "Not A(Brand";v="99"`;
- `Sec-CH-UA-Full-Version-List` with `148.0.7778.180`;
- Windows platform, x86 architecture, and 64-bit hints.

When optional Labs spoofing is enabled, a second identity mechanism replaces UA/Client Hints and injects JavaScript overrides for navigator, timezone, WebGL, location, and `webdriver`. This is a high-risk configuration for OAuth. Spoofing is disabled unless both the global Labs switch and its local feature flag are enabled.

The non-spoofed path does not inject `navigator.userAgentData`, so its manually rewritten request Client Hints may disagree with Chromium's JavaScript-visible high-entropy values. That inconsistency was not covered by the baseline tests.

## Popup and navigation routing before this sprint

- `setWindowOpenHandler` is the single main-process routing boundary.
- Safe ordinary `target=_blank` and `window.open(url)` requests are converted to Vast tabs.
- `about:blank`, identity-provider URLs, OAuth-like first-party URLs, payment URLs, and requests with popup geometry remain real `BrowserWindow` popups.
- A popup created with Chromium-provided `webContents` does not call `loadURL()` again. A direct URL without provided `webContents` is loaded once; `about:blank` is never force-loaded.
- Popup preferences are sterile in several important respects: no preload, no Node, isolation and sandbox enabled, web security enabled, no insecure content, no nested webviews.
- The opener relationship is preserved by using Electron's provided popup `webContents`; the local E2E verifies `window.opener`, `postMessage`, and session sharing for both direct and `about:blank` flows.

However, the worktree found at baseline explicitly denies Google identity-provider popup/navigation requests and offers the system-browser fallback (`google-embedded-oauth-not-supported`). Therefore it cannot satisfy in-app Google login as written.

## Request hooks and page intervention before this sprint

- `onBeforeRequest` can upgrade main-frame HTTP, block tracker hosts, and block ad requests.
- `onBeforeSendHeaders` always rewrites identity headers, even when Labs spoofing is disabled.
- OAuth-sensitive requests have no central bypass from tracker/ad/HTTPS/identity rewriting.
- Video & Audio can append a local authorization header to its own matching URL.
- Every webview receives the narrowly scoped guest autofill preload.
- On `dom-ready`, normal webviews may receive spoofing, cosmetic ad-block, site override, reader, login detection, and autofill JavaScript.
- Both BrowserStage and the popup code execute JavaScript that reads page title/body text to detect a provider-blocked OAuth page and offer an external fallback.
- `web-contents-created` and every main-frame navigation can apply geolocation spoofing via the DevTools debugger. The popup is marked trusted only during popup construction, so creation-order behavior requires explicit hardening.

## Baseline regression results

| Command | Result | Evidence |
|---|---|---|
| `npm run lint` | PASS | TypeScript no-emit completed, 35.5 s |
| `npm test` | PARTIAL: 271/272 | only Video & Audio security wrapper failed because Python cannot import `flask` |
| `npm run build` | PASS | Electron Vite main/preload/renderer build completed, 104.1 s |
| `npm run test:app` | PARTIAL | 35 browser/E2E checks passed, including both popup OAuth flows; suite then timed out waiting for Video & Audio because `flask` is missing |
| `npm run release:audit` | PASS | all reported security/release checks passed |

The Video & Audio failures are an environment dependency gap (`ModuleNotFoundError: No module named 'flask'`), not an auth-flow assertion failure. They remain visible and are not relabeled as passes.

## Known Google-login state

- The user previously observed Google's “This browser or app may not be secure” page with spoofing both enabled and disabled on the new computer.
- The current dirty worktree then added an explicit external-browser route for Google, so present tests validate fallback rather than in-app Google authentication.
- There is no current automated test against real Google credentials, and no success claim is possible from the local OAuth harness alone.
- Direct Google auth in a normal webview is not sterile: before the explicit deny/fallback it could receive request rewriting, guest preload, and several DOM scripts.
- The runtime is Electron/Chromium, not the `//chrome` browser product. Whether Google accepts a sterile top-level Electron window must be established by a controlled manual test; fallback cannot count as success.
