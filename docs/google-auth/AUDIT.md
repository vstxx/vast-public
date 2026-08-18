# Google/OAuth flow audit

Audit date: 2026-07-17

## Executive finding

Vast currently has a sound low-level popup primitive, but the complete Google path is not browser-neutral. A real Electron `BrowserWindow` is created with the opener session and with strong renderer security defaults, so local `window.opener`, `postMessage`, cookies, `about:blank`, and close behavior work. Around that primitive, however, Vast globally rewrites browser identity, runs request filters, may attach the DevTools debugger, injects several DOM scripts, reads OAuth page text, and—at the worktree baseline—explicitly denies Google navigation in favor of the system browser.

There is also an external constraint that code cannot legitimately remove: Google's current OAuth policy says a developer must not direct the authorization request to an embedded user-agent under the developer's control. Google's definition explicitly includes environments that allow arbitrary script insertion, routing changes, or access to cookies. Its desktop-app documentation names an embedded user-agent as a cause of `disallowed_useragent`. Sources:

- https://developers.google.com/identity/protocols/oauth2/policies#securebrowsers
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developers.google.com/identity/protocols/oauth2/resources/best-practices

Electron's official API confirms that the application controls `setWindowOpenHandler`, popup construction, sessions, UA, requests, and page JavaScript. A sterile `BrowserWindow` reduces accidental Vast interference but does not transform Electron into the Chromium `//chrome` browser product:

- https://www.electronjs.org/docs/latest/api/window-open
- https://www.electronjs.org/docs/latest/api/web-contents
- https://www.electronjs.org/docs/latest/api/session
- https://www.electronjs.org/docs/latest/api/web-request

Therefore two cases must be reported separately:

1. first-party Google website sign-in (Gmail/YouTube/Calendar/Drive), which can be tested experimentally in a sterile top-level Electron window using ordinary cookies;
2. third-party “Continue with Google”, for which an embedded Google OAuth authorization endpoint is officially unsupported. A system-browser/loopback or app-owned protocol flow is compliant for an app's own OAuth client, but it cannot generically recreate arbitrary websites' popup `window.opener` session inside Vast.

UA spoofing or fingerprint patching would not make case 2 compliant and is not an acceptable fix.

## Actual flow from click to return

1. A normal website is rendered in `BrowserStage.tsx` inside a `<webview allowpopups>` using Electron's persistent `defaultSession`. Private workspaces use `temporary:<workspaceId>`.
2. Chromium sends `window.open`/`target=_blank` to `installWindowOpenRouting()` in `src/main/sessions.ts` through `setWindowOpenHandler`.
3. `routeWebviewWindowOpen()` in `src/shared/window-open-policy.ts` classifies ordinary safe pages as `vast-tab`; blank/auth/payment/geometry requests become `popup-window`; unsafe schemes are denied.
4. Popup requests call `createOAuthPopupWindow()`. Electron's provided popup `webContents` is passed to a top-level `BrowserWindow`; the opener's exact `Session` is assigned; preload/additional arguments are removed; Node is disabled; isolation, sandbox, web security, and insecure-content blocking are enabled.
5. `shouldLoadPopupInitialUrl()` avoids a second `loadURL()` when Chromium already supplied `webContents`, and avoids force-loading `about:blank`.
6. The popup remains in `trustedOAuthPopupWebContents`, so safe HTTP(S) navigations are permitted and unsafe protocols are denied. It can retain native `window.opener` and return with `postMessage`.
7. At the audited worktree state, a Google URL is intercepted before this normal path and denied with `google-embedded-oauth-not-supported`. An external-browser prompt is displayed.
8. Non-Google popup pages are inspected after load with `executeJavaScript()`. If body text resembles a provider block, Vast offers the same external fallback.

## Intervention inventory

| File / function | Current behavior | Google-auth risk | Required scope | Proof test |
|---|---|---|---|---|
| `src/shared/oauth.ts` / `buildDefaultChromiumIdentity` | Creates a Chrome-like identity using embedded Chrome's exact version and removes `Electron` | Medium/high: classic UA and manually supplied CH look plausible, but are application-authored and can disagree with JavaScript UAData | Stop manually rewriting auth-sensitive requests; compare native vs exact-runtime Chromium identity only in an explicit test profile | Header/JS identity harness compares UA, low/high entropy hints, platform, architecture |
| `src/shared/oauth.ts` and `src/shared/window-open-policy.ts` | Duplicate Google/IdP host classifiers | Medium: rules can drift and route the same URL differently | Replace with one central auth compatibility policy | Table-driven classification tests including subdomain-boundary attacks |
| `src/main/sessions.ts` / `setupUserAgent` | Calls `Session.setUserAgent()` for default and new sessions | Medium: changes request and JS-visible UA globally | Use one documented identity profile; auth mode must not combine this with manual CH and JS spoofing | Identity-profile unit and local echo test |
| `src/main/sessions.ts` / `configureSpoofingForSession` | `onBeforeSendHeaders` removes/replaces UA and all CH even when Labs spoofing is off | High: potential mismatch with native high-entropy UAData and provider fingerprint | Auth-sensitive requests bypass spoof/custom identity mutation; native experiment must preserve incoming headers | Request harness captures unchanged auth-sensitive headers |
| `src/shared/spoofing.ts` / `buildSpoofingHeaders`, `buildSpoofingInjectionScript` | Can claim Chrome/Firefox/Safari, replace navigator/UAData, hide webdriver, alter WebGL/timezone/location | Critical for auth; explicitly resembles anti-detection and can create contradictions | Always disable for auth-sensitive windows/requests; do not use it to fix Google | Unit tests and popup probe verify no script/debugger/custom headers |
| `src/main/sessions.ts` / `configureTrackerBlocking` | HTTPS upgrade, tracker blocking, and ad blocking apply to every session; temporary sessions force tracker blocking | Medium/high: can block GIS/provider dependencies or alter a callback | Bypass only auth-sensitive requests; keep normal protections elsewhere | Harness URL marked auth-sensitive is neither redirected nor cancelled; normal tracker still blocked |
| `src/main/sessions.ts` / `createOAuthPopupWindow` | Strong top-level window defaults; removes preload; reuses opener session | Positive; this is the reusable primitive | Preserve and add explicit auth-window registration before navigation hooks run | Security-default and runtime E2E assertions |
| `src/main/sessions.ts` / `createOAuthPopupWindow.did-finish-load` | Executes JavaScript and reads up to 12,000 characters of title/body | High: active DOM inspection of provider pages; violates sterile-mode objective | Remove from auth-sensitive windows; rely on navigation/load events and explicit user fallback | Source/unit test rejects auth DOM probe |
| `BrowserStage.tsx` / `detectOAuthFallback` | Executes equivalent title/body probe in ordinary webviews | High for direct Google login; provider page is actively inspected | Remove automatic DOM inspection; fallback must be explicit or based on safe load/navigation signal | Renderer source/unit test and E2E |
| `BrowserStage.tsx` / `onDomReady` | Runs spoof, cosmetic blocker, site override, reader, login detection, and autofill scripts | High if an auth page is allowed in the webview | Auth-sensitive URL bypass for every nonessential injection; preferred Google path is the sterile top-level window | Script-injection policy unit tests plus harness counters |
| `src/main/sessions.ts` / `applySpoofingToWebContents` | Attaches CDP debugger for fixed geolocation; `web-contents-created` invokes it before popup trust may be registered | Critical: auth window can look automated/controlled | Register provided popup webContents before constructing the window and never attach/detach CDP in auth mode | Runtime popup reports `debugger.isAttached() === false` |
| `src/main/sessions.ts` / `installWindowOpenRouting` | Correctly preserves auth popup shape, but baseline explicitly denies Google URLs and offers external fallback | Functional blocker for the requested in-app experiment; compliant fallback for unsupported Google OAuth | Central policy must distinguish sterile experimental window from explicit external-required decision and log which was used | Routing unit tests for ordinary/blank/Google/direct callback cases |
| `src/main/sessions.ts` / `will-navigate` guard | Permits safe popup URLs and denies unsafe schemes; baseline denies Google | Generally positive; redirect handling is not represented as a shared helper | Apply the same safe policy to relevant main-frame redirects without rewriting callback data | Local redirect-chain E2E |
| `popup-initial-navigation.ts` | Loads only when no Chromium-provided webContents, URL is safe, and URL is not blank | Positive: prevents the known double-load bug | Preserve | Existing unit test plus direct/blank E2E |
| `web-contents-routing.ts` | Sends ordinary popup requests to exact host renderer/owner | Positive for Vast tabs; auth callback must not be accidentally converted to a tab | Preserve; auth popup remains a window until provider closes/returns | Existing routing tests plus callback-not-tab assertion |
| `BrowserStage.tsx` webview declaration | Normal tab has no partition; private tab has temporary partition; all webviews receive guest autofill preload | Cookie persistence is correct for normal tabs, but direct Google auth is not sterile inside the webview | Reuse exact opener session in popup; do not move normal users to a new partition; bypass/avoid guest webview for auth window | Restart persistence test and popup session equality |
| `src/main/sessions.ts` / permission policy | Unknown permissions default to block; no WebAuthn/passkey-specific implementation or tests | Unknown until runtime test; Windows Hello/passkey UI may depend on Electron/Chromium support outside app code | Do not relax permission security. Add a manual capability test and log outcome | Manual WebAuthn test; deterministic harness can only test no app denial/crash |
| `requestOAuthExternalFallback` | Redacted prompt can copy/open URL externally | Safe fallback, but cannot count as in-app success and cannot generically return arbitrary site cookies/opener state | Keep as explicit limited fallback; label outcome honestly | Unit tests for redaction and manual status classification |

## Cookie, opener, and callback conclusions

- Normal webviews and their popups use the same persistent `defaultSession`; cookie sharing is architecturally correct.
- Private popups inherit their opener's temporary partition, so private data does not leak into the normal profile.
- The local E2E already confirms opener, `postMessage`, callback navigation, cookie sharing, and close for both direct and blank-first popups.
- Converting ordinary auth callbacks to Vast tabs would break popup semantics; current routing avoids that.
- Opening Google in the system browser does not share Vast cookies and cannot preserve the webview's JavaScript opener. It is a fallback, not an implementation of arbitrary third-party in-page SSO.

## Identity experiment decision

Three configurations are relevant:

A. current: exact Chrome version in a hand-authored UA plus fully hand-authored CH;
B. exact-runtime Chromium-compatible UA with coordinated CH;
C. native Electron/Chromium request identity without auth-specific rewriting.

A is already known to be rejected on the user's machine and can be internally inconsistent. B is still deliberate impersonation and does not change Google's embedded-agent policy. C is the only honest sterile diagnostic configuration and is the required default for auth-sensitive experimental windows. If Google rejects C, the result is a provider/runtime limitation, not a reason to add fingerprint patches.

## Acceptance boundary for this sprint

The implementation can and should remove Vast-caused interference, make the popup deterministic, provide safe diagnostics, and prove generic OAuth semantics locally. It must not claim that this makes Google OAuth supported. A real credential/2FA session is required for first-party Google website evidence. Third-party “Continue with Google” must be classified against Google's policy and the observed result; an external fallback is reported separately and cannot improve the in-app success percentage.
