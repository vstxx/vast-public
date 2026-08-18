# Feature Status

Vast is local-first and does not collect browsing telemetry. When Vast Relay is
enabled for a build, its only operational telemetry is a random installation
UUID, the running Vast version, and a cumulative launch count. Relay records
server-generated first-seen and last-seen timestamps to deliver signed service
messages, update notices, and simple anonymous aggregate install counts. It
does not send browsing history, URLs, searches, tabs, accounts, hardware IDs,
or message interaction data. See [VAST_RELAY_CLIENT.md](VAST_RELAY_CLIENT.md).

## Default Stable Surface

- Chromium web navigation in sandboxed webviews
- Workspaces, tabs, bookmarks, history, downloads, reading list
- Settings, shortcuts, privacy controls, basic/focus reader mode, site data review, basic local notes
- JSON export/import and storage backup/restore

## Local Labs Surface

- Video & Audio
- Network Devices
- Automation
- Password Manager runtime use
- Advanced Diagnostics
- Spoofing tools

Labs defaults to off for fresh profiles. The Labs section and experimental commands remain hidden until the user enables optional features in Advanced settings. Each item then requires the global Labs flag and its own local flag. Turning a Labs feature off hides and blocks that feature but does not delete local data.

## Clean First Launch

A new profile starts with one empty workspace and one `vast://newtab` tab. The sidebar and side panel are closed, startup audio is muted, and New Tab shows only search plus at most three neutral quick links. Notes, todos, macros, timeline entries, folders, bookmarks, tab groups, and additional workspaces are not seeded. Schema 8 adds these clean defaults without replacing collections or preferences in an existing profile.

Advanced Notes, Session Timeline, advanced import/export, and multiple workspaces are part of the normal product surface. Experimental Themes is a neutral coming-soon entry.

## Known Limits

- SQLite storage is planned but not enabled in 1.0.9. JSON storage remains the compatible runtime format.
- Reader mode is a reversible focus stylesheet, not full article extraction.
- Vast has no product licensing backend, remote entitlement check, or plan-dependent feature state.
- Code signing requires CI secrets and is not reproducible from this repository alone.
