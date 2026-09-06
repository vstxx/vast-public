# Vast security architecture

This document describes the security boundaries used by the current Electron desktop implementation. It is an engineering description, not a guarantee that the application is free of vulnerabilities.

## Trust boundaries

Vast treats application chrome, browser guests, local privileged services, and remote service metadata as separate trust domains.

- The React application chrome runs with `contextIsolation: true`.
- Node integration is disabled in the renderer.
- The preload exposes a deliberately bounded `window.vast` API.
- Normal websites run in sandboxed Electron webviews and do not receive the Vast preload API.
- Filesystem, native dialogs, storage, password-vault operations, downloads, and other privileged operations remain behind main-process IPC.

Changes that expand a boundary are security-sensitive and should include regression coverage.

## Navigation and web content

Normal browser navigation is limited to HTTP(S), with internal `vast://` routes handled by trusted application code. Unsafe or privileged schemes are rejected from normal page-navigation paths. New-window handling and webview attachment are validated by the main process.

Packaged application chrome uses a restrictive Content Security Policy. Main-process download IPC accepts HTTP(S) sources only. The internal PDF path bounds downloaded bytes and validates the PDF signature before handing content to the viewer.

## IPC

IPC handlers validate input shape and keep privileged resources in the main process. Sensitive feature channels are mapped to local feature gates and fail closed when the relevant feature is disabled.

The renderer can request operations; renderer state alone does not authorize privileged actions. Filesystem access is not exposed as a generic renderer primitive.

## Password vault

Password records are stored outside normal browser-state JSON. Secrets are encrypted through Electron `safeStorage` before being written to disk.

Vault authorization is owned by the main process. Autofill and credential-capture flows are bound to the relevant guest `webContentsId` and exact HTTP(S) origin rather than trusting page-controlled metadata. Private-workspace behavior and sensitive actions are separately constrained.

`safeStorage` depends on operating-system facilities; it is not an independent cross-platform master-password or hardware-backed biometric system.

## Extensions

Vast supports Chromium-compatible extensions, local packages, and signed Vast Extensions Hub packages. Extension loading is treated as privileged code installation rather than ordinary website content.

Package identity, requested permissions, trust metadata, native API access, and renderer boundaries are validated by the extension subsystem. Native Vast APIs are intentionally narrower than arbitrary Node or shell access.

## Electron runtime hardening

Packaged releases apply and verify Electron Fuses before distribution. Public packages disable Electron behaviors that would allow the packaged application to be repurposed as a general Node runtime and enable ASAR integrity / ASAR-only loading according to the pinned Electron profile.

Release checks verify the real packaged executable rather than relying only on source configuration.

## Relay and notices

Vast Relay is not a browsing-telemetry channel. When enabled, its operational check-in is limited to a random installation UUID, running Vast version, and cumulative launch count; first-seen and last-seen timestamps are derived server-side. Browsing history, URLs, searches, tabs, bookmarks, account identity, hardware fingerprints, and message-interaction events are outside that protocol.

Signed service messages and update metadata are separated from executable update trust. Remote messages cannot grant local permissions, execute shell commands, change Labs state, or replace updater trust roots.

## Local Labs services

### Video & Audio

The optional Video & Audio surface starts a packaged local service on loopback. It receives no Node access through the browser UI and uses bounded, verified runtime dependencies. Public builds verify critical bundled runtime hashes and retain the required third-party license/source material.

### Network Devices

Network discovery is user-triggered and restricted to local/private or link-local network scope. Public-internet scanning, authentication attempts, and brute force are outside the intended feature boundary.

### Automation

Automation exposes bounded browser/product actions rather than arbitrary shell or page-script execution. New automation actions that cross authentication, payment, credential, download, or execution boundaries require separate review.

## Dependency and release gates

CI and release tooling include dependency vulnerability checks, source/history secret scanning, application tests, package-integrity checks, Electron Fuse verification, updater validation, artifact hashes, and third-party license/source checks.

The exact set of release gates is documented in [../RELEASE.md](../RELEASE.md) and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## Known limits

- Electron webviews remain a high-value security boundary and require careful review.
- Fingerprint/spoofing controls are best-effort and cannot make a browser perfectly indistinguishable from another environment.
- Content blocking is not a substitute for the browser sandbox or endpoint security.
- OS-bound encryption can limit password-vault portability between accounts or machines.
- Experimental features intentionally have narrower support guarantees than the default browser surface.
