# Power Tools Threat Model

This note covers Vast features that can affect local services, local files, or browser workflow state. These experimental features are gated only by local Vast Labs flags and should remain off by default for fresh profiles.

## Video & Audio

- Bound to `127.0.0.1` on a randomly allocated local port.
- Loaded into `vast://avidae` through a sandboxed iframe.
- Receives no Node.js access and no Vast preload API.
- Stores runtime jobs, uploads, downloads, and SQLite metadata under Electron `userData/avidae`.
- Treats `resources/avidae` as application code, not writable runtime data.
- Stops the child process during Vast shutdown.
- Runtime dependency installation is disabled in public release builds unless a trusted diagnostic build explicitly sets `VAST_ALLOW_RUNTIME_INSTALL=1`.
- FFmpeg, Python, and Playwright-style dependencies should be bundled or installed by a visible support flow.

## Network Devices

- User-triggered only.
- Passive discovery uses mDNS, SSDP, and ARP metadata.
- Active probing is disabled by default and governed by settings for timeout and concurrency.
- Scans are restricted to private and link-local address ranges.
- Vast must not scan public internet ranges, attempt authentication, brute force services, or submit forms.
- Device aliases, favorites, pins, and notes stay in local storage.

## Automation

- Macro actions are visible browser/workspace actions: open URLs, switch or create workspaces, add notes, save reading-list items, save snapshots, and toggle local UI state.
- Automation does not execute external commands.
- Automation does not inject arbitrary JavaScript into web pages.
- Automation does not silently download files.
- Automation does not submit forms or enter passwords.
- Any future action that can cross these boundaries needs a separate feature gate, UI confirmation model, and tests.
