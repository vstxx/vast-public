# Vast Security Model

Vast is an Electron browser shell. The app chrome and web content are intentionally separated.

## Supported versions

Security fixes target the latest published Vast beta or stable release and the current default branch. Older prereleases should be treated as unsupported once a newer release is available unless a release notice says otherwise.

## Reporting a vulnerability

Do not open a public issue containing exploit code, credentials, private user data, or enough detail to make an uncoordinated attack practical.

Use GitHub's **Security** tab and **Report a vulnerability** when private vulnerability reporting is available. The repository currently has no separate public security email. Before the repository is made public, the owner must enable GitHub Private Vulnerability Reporting and verify the reporting flow from a non-maintainer account.

If the private reporting button is unavailable, open a minimal public issue asking the maintainer to establish a private channel. Include no vulnerability details in that issue. Allow reasonable time for confirmation, remediation, and release coordination before publishing exploitable information. Reports should identify the affected version, platform, impact, reproduction prerequisites, and the least-sensitive proof needed to validate the issue.

## Process Boundaries

- The React app chrome runs in the Electron renderer with `contextIsolation: true`.
- `nodeIntegration` is disabled.
- The preload exposes only `window.vast`, a narrow bridge for storage, privacy actions, downloads, shell opening, browser events, and optional AI calls.
- Web pages render in sandboxed Electron webviews.
- Web pages do not receive the Vast preload API.

## Navigation Safety

Vast accepts only `http:` and `https:` page loads, plus internal renderer routes such as `vast://newtab`, `vast://avidae`, `vast://passwords`, `vast://automation`, `vast://network`, `vast://notes`, `vast://site-data`, and `vast://diagnostics`.

Blocked protocols include:

- `file:`
- `javascript:`
- `data:`
- `vbscript:`
- `about:`
- `chrome:`
- `chrome-extension:`
- `devtools:`
- `view-source:`

The main process also denies unsafe webview attachment and external window opens. App chrome/internal pages are served with a strict Content Security Policy in packaged builds: scripts are self-only, objects are disabled, `base-uri` is disabled, and frame ancestors are blocked. Vite development keeps only the additional local origins needed for the dev server.

`vast:browser:download-url` accepts only `http:` and `https:` URLs. Renderer-only `blob:` and `data:` downloads must use controlled anchor behavior instead of the main-process `downloadURL` IPC path.

PDF loading streams bytes with a 100 MB hard cap, rejects oversized `Content-Length`, aborts streams that exceed the cap, and validates the `%PDF` magic header before handing bytes to the internal viewer.

## IPC

IPC handlers live in `src/main/ipc.ts`. Handlers validate basic input shape and keep filesystem access in the main process. Renderer code can ask the main process to:

- Load/save Vast data
- Export/import Vast JSON data via native dialogs
- Clear cookies/site data
- Open/show downloaded files
- Open safe external URLs
- Start/stop the built-in Video & Audio backend and report its local status
- Manage the local password vault through a narrow password IPC surface. The renderer can list metadata and ask the main process to create/update/delete/copy/import/export credentials, but password files are never read directly by renderer code. Autofill requests are bound to the exact guest `webContentsId` and origin that requested the fill.
- Run local Network Devices discovery through a narrow IPC surface. The renderer can start a user-triggered scan, list cached metadata, update aliases/favorites/notes, forget devices, and export inventory, but it never receives raw Node network APIs.
- Run local macros through the renderer store/runtime only. Macros cannot execute shell commands, inject arbitrary JavaScript into web pages, submit forms, enter passwords, or download files silently.
- Enforce local Labs flags for sensitive feature IPC through one fail-closed channel-to-feature policy. Tests parse the TypeScript handler AST and compare every sensitive registration with the policy rather than matching source text with regexes.
- List/create/restore local storage backups through validated storage IPC.

Password Manager authorization lives in the main process. It begins locked on every app start, has a 15-minute absolute session, a 5-minute vault-inactivity timeout, a 2-minute fresh-unlock window for sensitive actions, and locks on OS screen lock or suspend. Lock state changes are broadcast to renderers only for presentation; renderer state cannot authorize an operation.

## Packaged Runtime

Electron Fuses are applied to the packaged executable in `afterPack` before signing and are read back before the hook completes. Public packages disable RunAsNode, `NODE_OPTIONS`, and Node CLI inspect arguments, and enable embedded ASAR integrity validation plus ASAR-only application loading. The profile explicitly sets every fuse supported by the pinned Electron version so an Electron upgrade cannot silently add an undecided fuse.

## Dependency audit for 0.1.5

The 0.1.5 remediation removed the three HIGH findings reported against the
previous lockfile:

- `js-yaml` CVE-2026-59870 (quadratic CPU denial of service through `!!omap`)
  is resolved by
  `js-yaml@4.3.1`;
- the `nanoid` custom-alphabet zero-size denial-of-service advisory is resolved
  by `nanoid@3.3.18` through the patched PostCSS dependency tree;
- the malicious-PDF JavaScript execution advisory in `pdfjs-dist` is resolved
  by pinning `pdfjs-dist@6.2.108`.

`npm run audit:ci` audits both the desktop and Relay lockfiles and fails CI at
HIGH or CRITICAL severity. The audited 0.1.5 dependency trees report zero known
npm vulnerabilities.

## Vast Notices

The updater and Vast Notices are independent trust domains. The updater remains pinned to its GitHub release infrastructure. Notices are disabled unless a separate exact HTTPS endpoint, key id, and Ed25519 SPKI public key are embedded at build time; GitHub updater origins are rejected.

The Notices fetch uses its own non-persistent, cache-disabled Electron session with credentials omitted. The response is bounded while streaming, must be `application/json`, cannot redirect, and contains a signed base64 JSON payload. Both envelope and payload use exact schemas. Notice fields are plain text only; HTML, script, commands, settings, Labs changes, automation, and update-endpoint fields are rejected as unknown data. Notices expose no shell, script execution, or updater dependency.

## Video & Audio

The `vast://avidae` page starts the vendored Video & Audio Flask app from `resources/avidae` in a child Python process. Vast binds it to a random `127.0.0.1` port and embeds it in a sandboxed iframe. Video & Audio receives no Node.js access and does not receive the Vast preload API.

Video & Audio stores jobs, uploads, downloads, and SQLite metadata under the compatibility path Electron `userData/avidae`. The source folder is treated as application code, not writable runtime storage. The child process is stopped during Vast shutdown.

Runtime dependency installation is disabled in release builds unless a trusted diagnostic build sets `VAST_ALLOW_RUNTIME_INSTALL=1`. Public Windows builds include a generated PyInstaller runtime, Playwright Chromium, FFmpeg, and FFprobe. A signed release cannot be built until their manifest hashes and executable self-tests pass; the app rechecks the critical hashes before launch. Video & Audio file access is limited to its own configured source and data paths.

## Network Devices

Network Devices is user-triggered and local-only. Passive discovery uses mDNS, SSDP, and ARP metadata. Active probing is disabled by default, rate limited by settings, and restricted to private or link-local IP ranges. Vast must not scan public internet ranges, attempt authentication, brute force services, or submit traffic without user action.

Per-device aliases, favorites, pins, and notes are local JSON data. Public IP scanning remains out of scope for the product.

## Automation

Automation macros operate through the renderer store/runtime with visible actions such as opening URLs, switching workspaces, adding notes, saving reading-list items, and toggling local UI state. They do not execute external commands, inject arbitrary JavaScript into pages, silently download files, submit forms, or enter passwords.

Adding any future action that crosses those boundaries should be treated as a new security review item and gated separately.

## Privacy

- Vast stores data locally in Electron `userData`.
- Vast creates rolling/manual storage backups under `userData/storage-backups` before risky storage replacement paths.
- Vast collects no browsing telemetry. If Vast Relay is enabled, the only
  operational check-in contains a random installation UUID, the running Vast
  version, and a cumulative launch count. Relay derives first-seen and
  last-seen timestamps. These pseudonymous records power simple anonymous
  aggregate installation counts, signed messages, and update notices.
- Relay never sends browsing history, URLs, searches, tabs, bookmarks, device
  fingerprints, account identity, or message interaction events.
- No AI provider is called unless the user explicitly triggers an AI action.
- API keys are read from environment variables and are not persisted.
- The tracker blocker is intentionally simple and blocks a small list of common tracker hosts when enabled.
- Isolated workspaces use temporary webview partitions, skip history recording, and do not persist open tabs into session restore.
- Passwords are stored outside normal Vast browser data in `password-vault.json`. Password secrets are encrypted by the main process with Electron `safeStorage` before being written to disk.
- Vast does not read Chrome profiles or browser password databases, does not sync with Google Password Manager, and treats Chrome/Google CSV compatibility as manual import/export only.
- Autofill is user-controlled. Vast only offers fill/save actions for exact http(s) origins and does not silently save credentials.
- Private workspaces do not save captured logins.
- Network Devices scans are manual, local-only, and limited to private/link-local ranges. Passive discovery uses mDNS/SSDP/ARP; active probing is off by default and never attempts authentication, brute force, or public-IP scanning.
- Notes are explicit local actions. Notes data remains local and exportable. Page text is not sent externally, and page text capture can be disabled in Privacy settings.

## Known Limits

- Electron webviews are powerful. Treat webview integration changes as security-sensitive.
- The tracker blocker is not a full content blocker.
- Fingerprint spoofing is best-effort. User-agent/header/geolocation controls can help with consistency, but late page scripts may observe values before a webview injection runs.
- Extension/plugin support is not enabled yet.
- `safeStorage` is the current encryption backend. Session unlock is a main-process authorization lifetime, not a cross-platform biometric or independent master-password system; stable platform re-authentication would require a separately maintained native integration.
- Vast has no product entitlement backend or remote feature verification. Labs decisions use local settings and are rechecked in main-process IPC.
- Public stable updater and signing secrets are expected from CI environment variables and must not be committed.

## Reporting Issues

For local development, inspect:

- `src/main/sessions.ts`
- `src/main/ipc.ts`
- `src/preload/index.ts`
- `src/renderer/components/browser/BrowserStage.tsx`
