# Vast 2 Chromium architecture

Status: accepted for the `2.0.0-dev` migration. This document describes the target architecture and the boundaries that protect Vast 1.0.11 while the port is incomplete.

## Decision

Vast 2 is built from an exact upstream Chromium revision and the real `//chrome` browser target. It is not an Electron application and does not embed CEF, WebView2, QtWebEngine, `content_shell`, Node.js, or a local HTTP UI server.

The upstream checkout lives outside this repository. This repository owns a small versioned overlay: revision metadata, patches, branding resources, WebUI sources, migration code, tests, and PowerShell orchestration. A fresh checkout plus that overlay must reproduce a build.

The Electron 1.0.11 source tree remains the production implementation during migration. Chromium work is additive under `chromium-port/`; no 2.0 development command may write to the installed application or its active profile.

## Process and component model

```text
Vast.exe (Chromium //chrome browser process)
  |-- native Browser/Profile/TabStripModel/DownloadManager/permissions
  |-- Vast browser services (C++): product data, migration, backup, feature flags
  |-- Mojo interfaces with explicit typed methods
  |-- chrome://vast-* WebUI controllers and React bundles
  `-- sandboxed renderer/GPU/utility/network processes
```

Normal websites are ordinary Chromium tabs backed by `content::WebContents`. Chromium owns cookies, storage partitions, service workers, navigation, downloads, popups, certificate handling, sandboxing, and site isolation. Vast does not inject a Chrome-like user agent or weaken browser security.

Google sign-in means a user can visit `accounts.google.com` as a top-level page and establish website sessions used by Gmail, YouTube, and Calendar. Chrome browser sign-in and Chrome Sync are deliberately out of scope. The build must not contain `google_default_client_id`, `google_default_client_secret`, Google Chrome branding, or restricted private Chrome APIs.

## Reuse classification

### Directly reusable TypeScript/React

Pure UI and domain code without `window.vast`, Electron DOM elements, or Node imports can be bundled into Chromium WebUI with modest build changes. This includes much of the New Tab, settings presentation, notes, password list UI, automation UI, diagnostics UI, Video & Audio UI, feature gates, formatting utilities, themes, icons, and pure shared helpers/tests.

`src/shared/types.ts`, local feature-flag rules, URL presentation helpers, shortcuts, store migration logic, and most Zustand reducers remain the canonical behavioral reference. They are reusable only where their data ownership does not conflict with Chromium's native tab/profile models.

### Reusable with adapters

The following retain their UI/business behavior but require a typed native service:

- `browser-store.ts`: workspaces, Vast product data, notes, macros, and settings survive; live tabs, history, downloads, permissions, and sessions move to Chromium-native models.
- Internal React pages: registered as `chrome://vast-*` WebUI pages and communicate over Mojo/WebUI handlers.
- `vast-data.json` validation/migrations and `.vastbackup` semantics: ported to a native service or a migration helper with byte-for-byte fixtures and compatibility tests.
- Password UI/import/export: backed by Chromium/Windows cryptographic facilities; old encrypted values are never assumed decryptable in a different OS account/profile.
- Video & Audio, network devices, AI integrations, updater, and local feature decisions: native service boundaries replace Electron IPC and Node filesystem/process calls.

### Electron-specific replacements

| Current implementation | Chromium 2 implementation |
| --- | --- |
| Electron `BrowserWindow` | `Browser`, native Views frame, Windows app identity |
| renderer `<webview>` | normal Chromium tabs / `content::WebContents` |
| Electron `session` and partitions | `Profile`, `StoragePartition`, `CookieManager`, content settings |
| preload `window.vast` / `ipcRenderer` | typed Mojo or constrained WebUI message handlers |
| Electron main IPC handlers | keyed services / browser services in C++ |
| `safeStorage` | Chromium OSCrypt/password-store integration plus explicit legacy import status |
| Node filesystem/process APIs | `base::FilePath`, `base::File`, utility processes, native launch APIs |
| `electron-updater` | Vast-native signed updater/installer with UAC and rollback |
| Electron download/window-open hooks | Chromium download, navigation, popup, and permission delegates |
| Electron protocol plumbing | registered WebUI data sources and internal URLs |

Electron UA spoofing and injection used to resemble Chrome is obsolete and must not be ported as an authentication workaround. Any retained privacy controls must be internally consistent and described as best effort.

## Profile and product-data boundary

A development launch always passes a dedicated temporary `--user-data-dir`; it never defaults to `%APPDATA%\Vast` or the 1.0.11 Electron profile. Chromium profile state (cookies, service workers, cache, native history/download databases) is separate from Vast-owned product state.

Vast product data retains its logical files and schema contracts:

- `vast-data.json` (current schema version 5);
- `password-vault.json` (legacy schema version 1, encrypted payload caveat);
- stable `data-root.json` selection;
- `.vastbackup` format version 1 with manifest and SHA-256 checksums;
- workspaces, bookmarks, notes, sessions, settings, macros, and related arrays.

Migration is an explicit transaction: discover the configured Electron root, validate it, create a safety backup, copy to a new staging root, validate/convert there, and atomically select the new root only after success. Source data is read-only. A journal records source, destination, checksums, warnings, and rollback instructions. Cookies and OS-bound secrets are excluded unless Chromium itself can import them through a supported API; authenticated cookies are never copied from another browser.

The default WebUI-facing compatibility layer remains deliberately preview-only. It accepts a disposable copied fixture, reads at most 8 MiB of `vast-data.json` on a `MayBlock` ThreadPool task, validates the schema/collection envelope, and returns only aggregate counts. It checks whether `password-vault.json` exists but never opens it. No record contents, URLs, credentials, cookies, encryption material, or source paths cross the Mojo boundary.

The native-only transaction layer goes further without expanding renderer authority. It resolves `data-root.json`, copies an explicit Vast product-data allowlist into a safety backup, produces a second checksum-verified staging tree, and atomically promotes only a previously nonexistent destination. The journal remains in the browser process domain. Rollback moves committed data into a transaction holding directory; it never edits or deletes the Electron source. Electron/Chromium browser-profile artifacts—including cookies, `Local State`, `Preferences`, and website sessions—are deliberately outside the allowlist.

During development, this transaction can be exercised from `chrome://vast` only when the browser was launched with an explicit fixture root, transaction parent, and dedicated enable switch. The renderer passes a confirmation boolean but no path. The browser process uses a fixed destination name and returns only state, file count, and sanitized errors. This is test plumbing, not the production directory-picker/import authority; without all three native switches the write path is disabled.

The same development boundary accepts a pre-authorized backup switch as an alternative—not an addition—to the data-root fixture. Preview verifies the archive into a temporary sibling and deletes it. Commit deliberately re-verifies the archive, prepares safety/staging, deletes the extraction, and only then promotes the staging root. This double verification prevents an archive changed after preview from entering the transaction. The archive path remains native and never appears in Mojo.

The first typed product-data adapter is intentionally read-only. It projects only validated workspace identity/presentation/order/privacy/active state and an allowlisted appearance/layout settings subset with safe fallbacks. It does not project live tabs, URLs, history, downloads, notes, credentials, vault contents, cookies, or other browser-profile data. A later profile-scoped service may expose this projection only after a persistent Vast 2 product root has been selected and recovered successfully.

A committed root can be activated by writing a small native-only selection record below the Chromium profile. The record is only a locator, never an authority: every restart reopens the committed migration journal, enforces its transaction-directory topology and product-data allowlist, verifies bounded size totals and SHA-256 values in both the active root and safety backup, and reruns the typed projection. A recovered transaction retains enough native state to move the committed root into its rollback holding directory. Selection metadata is cleared only after that move succeeds; the Electron source and safety backup remain untouched.

The development WebUI integration activates this root only after commit succeeds. `GetProductDataStatus` performs recovery on a `MayBlock` worker and returns the allowlisted workspace/settings projection through generated Mojo types; native paths, journal entries, checksums, tabs, URLs, history, notes, and secrets never cross the interface. A fresh browser process on the same disposable profile can show the recovered state and request rollback; the new controller reconstructs transaction state from the verified journal instead of relying on in-memory state from the process that committed it.

Recovered state is owned by `VastProductDataService`, a regular-profile `KeyedService`, rather than by one WebUI controller. Concurrent status requests share one worker recovery and validated in-process snapshot; commit and rollback explicitly invalidate it. `VastProductDataServiceFactory` is registered in `ChromeBrowserMainExtraPartsProfiles::PreProfileInit`, before any profile is created, so it participates in Chromium's complete keyed-service dependency graph. Creating this factory lazily at first WebUI navigation is invalid and intentionally not supported.

`.vastbackup` v1 is handled before the transaction. The native verifier reads a bounded archive, independently validates its ZIP central/local metadata and Windows-safe paths, parses the v1 manifest, and streams every declared entry through Chromium's upstream ZIP reader for CRC and SHA-256 verification. Only allowlisted Vast product data is materialized into a temporary source root; browser cookies and profile state may be verified for archive integrity but are not extracted. The temporary product root then enters the same safety-backup/staging/commit/rollback pipeline as a directory migration.

## UI integration

Browser-critical chrome (window frame, tab strip, toolbar, omnibox, page actions, permission indicators) stays in Chromium Views for correct focus, accessibility, drag regions, popup behavior, and lifecycle semantics. Vast visual tokens and commands may be applied through narrowly scoped Views changes.

The first native shell uses a late Vast-owned color mixer after Chromium's Material and platform mixers. It sets the stable frame, toolbar, tab, omnibox, bookmark-bar, and NTP roles while returning immediately for high-contrast mode; a user custom theme is applied afterward and remains an explicit override. This keeps the patch surface centralized instead of scattering paint changes across Views classes.

For regular profiles, Chromium's existing `chrome://newtab` rewrite resolves to `chrome://vast`. Incognito and guest profiles retain the upstream NTP so normal-profile product data is never projected across the off-the-record boundary. Chromium preserves the virtual `chrome://newtab` URL while the real profile-scoped Vast controller serves the page. The page renders only the allowlisted workspace/settings projection owned by `VastProductDataService`. Its rail selects the same validated workspace state as the native toolbar; tab ownership is handled separately in the browser window and never sent through WebUI.

The first persistent native product control is `VastWorkspaceButton`, a Chromium Views toolbar chip inserted only for regular profiles. It remains present while ordinary websites own the active WebContents, so Vast commands are no longer limited to the New Tab renderer. With recovered product data it opens a native checked-radio workspace menu plus a normal Chromium navigation command for `chrome://vast/`; otherwise it opens the hub directly. The chip subscribes to completed validation results from `VastProductDataService` and displays only the active workspace name and private marker from the safe projection. Incognito and guest windows neither construct the control nor request normal-profile product data. Windows UI Automation validates the real Views popup, private selection, accessibility label, hub target, and recovery after relaunch.

Workspace selection never writes the recovered or Electron `vast-data.json`. `VastProductDataService` validates the requested ID against its recovered projection, then atomically writes only a small `VastProductData/workspace-selection.json` overlay below the Chromium profile. The envelope includes the exact absolute migration journal path, so a record from a rolled-back or replaced import is a successful no-op. Recovery first verifies the product root and journal as before, then applies a matching known ID in memory and publishes the revalidated result to Views and WebUI. Malformed or unknown overlays cannot change the underlying active marker.

`VastWorkspaceTabController` is owned per regular browser window by the native workspace chip and observes that window's `TabStripModel`. Each validated workspace maps to a normal Chromium tab group with a deterministic Vast title/color. Switching expands and activates the selected group and collapses other Vast-owned groups; newly inserted, unpinned, ungrouped tabs join the active workspace on the next task turn, and already-present ungrouped tabs are reconciled after asynchronous product recovery. Existing unrelated native groups are neither renamed nor claimed, pinned tabs stay global, and the adapter never receives or persists URLs. Empty workspaces open the real `chrome://vast/` surface.

Exact native group ownership survives restart through `VastProductData/workspace-tab-groups.json`. Its authority is deliberately narrow: format version, exact absolute migration journal, and at most 128 `{workspaceId, groupToken}` records containing canonical nonzero `base::Token` strings. Loading fails closed on links, oversize/malformed envelopes, unknown workspaces, duplicate tokens, or stale migration identity. The profile-keyed service serializes atomic read-modify-write updates from every browser window. Controllers order asynchronous loads by status generation, prefer exact `TabGroupId` matches, and use the reserved title convention only to migrate groups created by patch `0021`. Chromium may add a missing active-workspace group when restoring a window that never had one; previously registered tokens must all remain present. Last-active-tab pointers are still process-local, and stale-token compaction remains future work.

Product surfaces use Chromium WebUI where appropriate:

- `chrome://vast` (current regular-profile New Tab and shell dashboard);
- `chrome://vast-settings`;
- `chrome://vast-notes`;
- `chrome://vast-passwords`;
- `chrome://vast-automation`;
- `chrome://vast-avidae`;
- additional diagnostics, network, session, reader, and site-data panels as they are ported.

Bundles are compiled resources served by `WebUIDataSource`, not a localhost server. Interfaces use generated Mojo types and validate profile, origin, argument size, file paths, and local feature gates in the browser process.

## Patch ownership and updates

`chromium-port/revision.json` pins both an upstream version and commit. `patches/series.json` defines application order. Each patch should introduce or touch a cohesive Vast-owned component; changes to high-churn upstream files require a documented reason. Scripts perform `git apply --check` before mutation and fail on a dirty or unexpected checkout.

A Chromium update is a controlled rebase: fetch the candidate stable security revision, create a disposable work branch, apply the series, run GN generation/build/tests, record conflicts, and update the pin only after verification. Electron releases remain independent.

## Security invariants

- Sandbox, site isolation, web security, certificate verification, Safe Browsing-compatible architecture, and default permission checks stay enabled.
- Website renderers receive neither Node.js nor arbitrary native filesystem access.
- Mojo/WebUI entry points are least-privilege and profile-scoped.
- Development profiles and migration fixtures are disposable and contain no real credentials.
- Tests never automate entry of Google credentials.
- Signing hooks accept secrets from an external secure environment; no private material is committed.

## Known distribution limitations

An open Chromium build cannot claim Google Chrome Sync or proprietary Google services. Widevine distribution requires a separate license and supported integration; it is not bundled by default. Codec availability follows Chromium's legal build configuration and may omit proprietary formats such as patent-encumbered H.264/AAC configurations. Google Chrome trademarks and assets are not used. These limitations are packaging/product constraints, not reasons to spoof browser identity.
