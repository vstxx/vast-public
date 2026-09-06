# Feature status

This document describes the current product boundaries at a high level. Detailed behavior is defined by the implementation and focused documentation rather than by old release worklogs.

## Default browser surface

- Chromium web navigation in sandboxed Electron webviews
- Vertical and horizontal tab layouts, groups, pinned tabs, split view, session restore, and smart tab unloading
- Workspaces, bookmarks, history, downloads, reading list, quick links, and site memory
- Settings, editable shortcuts, privacy controls, site-data review, Focus Reader, PDF viewing, and local notes
- Command palette and browser/search shortcuts
- Chromium-compatible extensions, local `.vext` packages, and Vast Extensions Hub packages
- Export/import, storage backups, diagnostics, and updater/release verification support

## Optional Labs surface

Labs is disabled on fresh profiles and requires explicit local opt-in. Individual Labs surfaces remain separately gated.

- Video & Audio
- Network Devices
- Automation
- Password Manager
- Advanced Diagnostics
- Spoofing tools

Disabling a Labs feature hides and blocks its active surface but does not silently delete the user's local data.

## Data and privacy

Normal Vast product data is local to the selected profile/data root. Vast does not collect browsing telemetry.

When Relay is enabled, its operational check-in is limited to a random installation UUID, running Vast version, and cumulative launch count. Relay derives first-seen and last-seen timestamps and does not receive browsing history, URLs, searches, tabs, bookmarks, account identity, hardware fingerprints, or message-interaction events.

See [PRIVACY.md](PRIVACY.md) and [DATA_MIGRATION_AND_STORAGE.md](DATA_MIGRATION_AND_STORAGE.md).

## Distribution support

Windows x64 is the current release-supported and continuously exercised target. Direct installer/portable packages and Microsoft Store packaging use different update/signing boundaries but share the same product data model for installed builds.

macOS and Linux build targets exist in configuration but are not currently release-supported or continuously verified.

The `chromium-port/` tree is experimental engineering work and is not the current distributed desktop implementation.

## Known limits

- JSON remains part of the current product-storage model; storage changes must preserve recovery and export/import compatibility.
- Focus Reader is a browser reading/focus treatment, not a claim of perfect article extraction or offline archiving.
- Electron `safeStorage` is OS-backed encryption, not an independent cross-platform master-password or biometric system.
- Experimental Labs features carry narrower support guarantees than the default browser surface.
- Code-signature status depends on the specific release route; users should follow the signature and verification note attached to the release they download.
