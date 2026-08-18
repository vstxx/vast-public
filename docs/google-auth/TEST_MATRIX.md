# Google Auth test matrix

Status: **local OAuth mechanics pass; user reports successful native Electron login; fresh packaged Google acceptance is not reliably reproduced**.

This matrix separates Vast mechanics from provider acceptance. No test imports cookies, enters a password, reads Google DOM, or records credentials.

## Current test build

- Product: Vast 1.0.11 internal unsigned directory build
- Base Git commit: `5a47c632fa78cd21fe1b85af2d57b9ce72997577` plus documented dirty-worktree changes
- Runtime: Electron 42.3.0 / Chromium 148.0.7778.180
- Production auth model: `sterile-top-level-window`
- Production auth identity: `native-electron`
- Build: `.vast-test-artifacts/final-polish-test-final-native/win-unpacked/Vast.exe`
- `Vast.exe` SHA-256: `fd78b51136cac8c8b560b6537c8165a2f6d3504d8bc23a17feab6a7dffb266fc`
- `app.asar` SHA-256: `d2996ba6f0ed32bed71b5202009cec19acaf296cc47c4574cd1a9f70ee0547ef`
- Automated profiles: disposable and outside `%APPDATA%\Vast`
- Updater during test: disabled

## Deterministic matrix

| Scenario | Result | Evidence |
| --- | --- | --- |
| Ordinary `target=_blank` / `window.open` | PASS | Normal Vast tab |
| Blank-first and direct OAuth popup | PASS | Real top-level popup |
| `window.opener` and `postMessage` | PASS | Local callback returned |
| Shared opener session/cookie | PASS | Cookie visible in local popup |
| Provider closes popup | PASS | No accidental tab persisted |
| Node and Vast preload absent | PASS | Runtime probes |
| Sandbox/security defaults | PASS | Isolation, sandbox and webSecurity enabled |
| CDP absent in production flow | PASS | Creation diagnostic says `debugger=false` |
| Spoof/cosmetic/reader/site injection absent | PASS | Policy and runtime probes |
| Auth request-hook bypass | PASS | Scoped blocker/header tests |
| Sensitive log redaction | PASS | No account/query secrets |
| Unsafe protocol blocking | PASS | URL-safety regression |

## Provider experiments

| Experiment | Test debugger | Identity | Result | Interpretation |
| --- | --- | --- | --- | --- |
| Development email-only check | Attached by CDP harness | native Electron | Reached password URL | Diagnostic only; invalid as clean provider-acceptance evidence |
| Packaged email-only check | None | exact Chromium 148 classic UA, native Client Hints | `PROVIDER_BLOCK_AFTER_EMAIL`, `/signin/rejected` | Valid negative provider evidence |
| Packaged email-only check | None | native Electron | `INCONCLUSIVE`; input events did not advance identifier | Neither pass nor rejection |
| User-operated login in Vast | None | native Electron | PASS reported by user | Real-use evidence; profile freshness/persistence not independently observed |

Authoritative redacted artifacts:

- packaged Chromium-runtime rejection: `.vast-test-artifacts/google-auth-live-ui-check/2026-07-17T01-45-09-462Z/summary.json`;
- packaged native-Electron inconclusive run: `.vast-test-artifacts/google-auth-live-ui-check/2026-07-17T01-46-59-979Z/summary.json`.

## Regression result

| Command | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm test` | PASS, 284/284 |
| `npm run build` | PASS |
| `npm run test:app` | PASS, 57/57 |
| `npm run test:updater` | PASS |
| `npm run release:audit` | PASS |
| Packaged launch on isolated profile | PASS |

## Manual matrix still required

Fresh password/2FA, Gmail, YouTube, Drive, Calendar, Docs, restart persistence, logout/relogin, second account and passkey/WebAuthn remain `PENDING`.

ChatGPT, Canva, Notion, Figma, Linear, Supabase, Cloudflare, Slack, Dropbox and Trello “Continue with Google” also remain `PENDING`. No 90% claim is made. External fallback never counts as in-app success.

## Conclusion

Vast popup/session/opener/callback behavior is deterministic and secure. Google acceptance is not: one user-operated native flow worked, a clean packaged Chromium-runtime flow was explicitly rejected, and a packaged native automated flow was inconclusive. Further UA/fingerprint experiments are stopped by design.

