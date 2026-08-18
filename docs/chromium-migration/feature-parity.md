# Vast Chromium feature parity

Statuses: `inventory`, `planned`, `in-progress`, `verified`, `deferred`, `obsolete`. A feature becomes `verified` only after an automated or recorded manual acceptance check on the native Chromium build.

| Priority | Feature | Electron 1.0.11 implementation | Chromium 2 target | Status | Acceptance evidence |
| --- | --- | --- | --- | --- | --- |
| P0 | Browser frame | `BrowserWindow` plus React chrome | Chromium `BrowserView`/Views frame, Vast branding | in-progress | Native frame/tab/toolbar/omnibox tokens use the Vast palette; dedicated tests preserve high-contrast; Windows UI Automation verifies the persistent Vast chip, checked workspace menu, private label, hub navigation, and restart recovery; deeper Views layout changes remain |
| P0 | Vast internal UI bridge | Electron renderer + preload IPC | GRIT WebUI bundle + profile-scoped typed Mojo | verified | `chrome://vast` DOM/screenshot smoke obtains runtime facts through `PageHandler.GetRuntimeInfo` |
| P0 | Tabs/navigation | React store plus `<webview>` | `TabStripModel`, `WebContents`, navigation controller | verified | Automated two-tab DevTools smoke test passes |
| P0 | Address bar/search | React `AddressBar` | Chromium Omnibox with Vast presentation/settings adapter | in-progress | Native omnibox uses Vast shell tokens; the Vast NTP search form targets top-level Google; editable/search-provider adapters remain |
| P0 | New Tab | React `NewTabPage` | `chrome://vast` profile WebUI through Chromium NTP rewrite | in-progress | `chrome://newtab` resolves to the Vast-titled WebUI; DOM/screenshot smoke verifies home, search, native destinations, and restart-safe workspace projection |
| P0 | Profiles/cookies | Electron sessions/partitions | Chromium `Profile` and storage partitions | verified | Cookie persists across a full native browser restart in a disposable profile |
| P0 | Google website login | Embedded Electron guest plus external fallback | Ordinary top-level Chromium tab; no Sync APIs | in-progress | `accounts.google.com` top-level navigation passes; manual credential checklist pending |
| P0 | Workspaces | Zustand/`vast-data.json` | Vast keyed service + tab model adapter + WebUI/Views | in-progress | NTP rail and native checked toolbar menu switch validated workspaces through one keyed service; a browser-window `TabStripModelObserver` maps them to native Chromium groups, auto-assigns new unpinned tabs, and switches groups without exposing URLs; a bounded journal-scoped registry retains exact native group tokens across forced process restart; create/rename/delete and imported tab-URL migration remain |
| P0 | Bookmarks | JSON store and React UI | Chromium bookmark model plus compatibility import | inventory | Import and CRUD test |
| P0 | History | JSON entries | Chromium history service plus compatibility import | inventory | Navigation/history test |
| P0 | Downloads | Electron download hooks + JSON mirror | Chromium download manager and UI adapter | in-progress | Native download completes; Vast metadata/UI adapter remains |
| P0 | Crash-safe sessions | JSON snapshots and close handshake | Chromium session restore + Vast workspace metadata | in-progress | Forced process restart restores named Alpha/Beta native groups and retains every registered group token; persisted last-active-tab identity, registry compaction, and broader session fixtures remain |
| P0 | Settings/appearance | React modal, schema 5 settings | `chrome://vast-settings`, prefs adapter, themes | in-progress | Safe theme/accent/layout/session settings drive the NTP presentation after restart; native shell has a tested baseline palette; editable WebUI/Prefs adapter remain |
| P0 | Backup/import | `.vastbackup` v1 ZIP, manifest/checksums | Compatible native migration/backup service | in-progress | Real backup passes audit, pathless commit, profile-local activation, full process restart, checksum recovery, rollback, and deselection; production picker and export remain |
| P1 | Side panels | React `SidePanel` | Chromium side panel coordinator + Vast WebUI | inventory | Open/persist/focus test |
| P1 | Notes | React + JSON | `chrome://vast-notes` + product-data service | inventory | CRUD/migration test |
| P1 | Password vault | Electron `safeStorage`, JSON metadata | Chromium/OSCrypt-backed service; explicit legacy status | inventory | New vault CRUD and legacy fixture report |
| P1 | Reader mode | injected readability script | Chromium distillation/reader integration | inventory | Article fixture test |
| P1 | PDF | pdf.js internal page + Electron print | Chromium PDF viewer/printing with Vast entry points | inventory | Local/remote PDF checklist |
| P1 | Permissions/site info | Electron permission handlers | Chromium content settings and page info | in-progress | Permissions API and popup smoke pass; UI/parity tests remain |
| P1 | Command palette | React commands/shortcuts | Vast WebUI/Views command controller | inventory | Keyboard command test |
| P1 | Updater | `electron-updater` + .NET bootstrapper | Signed Vast native updater, UAC, rollback | inventory | Dry-run package update |
| P2 | Video & Audio | Python Flask/Playwright/FFmpeg sidecar | Native service boundary; sidecar policy TBD | inventory | Feature-specific suite |
| P2 | Macros/automation | React + Electron IPC | Mojo/native automation service with permission model | inventory | Fixture macro test |
| P2 | Network devices | Node discovery/services | Sandboxed native/network service | inventory | Controlled LAN test |
| P2 | Local Labs flags | Electron settings and main-process gates | Profile-scoped native feature service | inventory | Global/per-feature flag tests |
| P2 | AI integrations | Electron/Node integration handlers | Native network service + explicit consent | inventory | Mock endpoint test |
| P2 | Diagnostics/performance | Electron process metrics | Chromium tracing/metrics + Vast WebUI | inventory | Diagnostics page test |
| P2 | Advanced privacy | session headers and injected JS | Honest Chromium prefs/policies only | inventory | Security review |
| - | Chrome impersonation for login | UA/client-hint/JS spoofing | Not ported | obsolete | Must remain absent |
| - | Chrome browser sign-in/Sync | Not a supported Vast feature | Out of scope; Vast sync remains independent | deferred | Documented limitation |
| - | Google private API keys | Not required for website login | Must remain absent | obsolete | Secret/static-string audit |

## Existing data inventory

`PersistedData` schema 5 currently contains workspaces, tab groups, tabs, recently closed tabs, bookmarks and folders, history, downloads, notes, reading list, quick links, site memory, todos, macros and logs, session snapshots, and settings. The port must decide per collection whether Chromium is authoritative or whether it remains Vast-owned; it must not silently maintain two conflicting sources of truth.

The current feature registry uses local Labs flags for Video & Audio, network devices, password manager, automation, advanced diagnostics, and spoofing. Advanced Notes, Session Timeline, advanced import/export, and multiple workspaces are normally available; Experimental Themes remains coming soon. Equivalent Labs gates must be enforced in the native service, not only hidden in WebUI.
