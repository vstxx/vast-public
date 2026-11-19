## What changed since 0.5.5

- **Vast for Linux.** A 64-bit AppImage (`Vast-0.6.0-x86_64.AppImage`) runs on recent distributions without FUSE 2 and updates itself in place. See [docs/LINUX.md](https://github.com/vstxx/vast-public/blob/v0.6.0/docs/LINUX.md) for Gear Lever and manual installation.
- **Security update of the browser engine.** Vast now runs on a patched Electron 45.3.4 (Chromium 156.0.8078.100, Node.js 24.22.3) with the Vast extension-compatibility patch set. This brings the upstream security fixes backported to Chromium, V8, ANGLE, Dawn and Skia since 0.5.5, and stops trusting certificates from eMudhra's revoked intermediates.
- **Video & Audio is a separate download.** The installer no longer bundles the Video & Audio runtime, so it is much smaller. The first time you open Video & Audio, **Download & Install** fetches the signed module once. It is verified before installation. Your existing jobs, settings and media stay where they are.
- **History.** Remove a single page, every page from a site, the current search results or a time range. Each deletion can be undone.
- **Command palette.** Better ranking that ignores accents and matches several words, searches all history and bookmarks, removes duplicates, and supports `@tabs`, `@history`, `@bookmarks`, `@notes` and `>` scopes. Shift+Delete removes a history entry.
- **Onboarding** appears only once. Profiles that older builds kept sending back to setup are repaired. A **Skip setup** link was added, and you can run setup again from Settings > Data.
- **Motion setting.** Choose Off, Standard or Enhanced. Reduced-motion and low-effects settings still take precedence.
- **Notes.** You can hide the notes list and the details panel to give the editor the full window width.
- **Extensions.** Extension entries in the Chromium right-click menu now appear in Vast's page menu. iCloud Passwords no longer leaves its "Enable Password AutoFill" box stuck next to login fields.
- **Fixed:** the address bar again updates when you follow a link or go back or forward (a regression in 0.5.5).
- **Performance.** With Standard fingerprinting protection, sites now see your real number of CPU cores, so sites that split work across many workers run faster. Strict and Maximum still hide it. Sites that call `history.replaceState` many times a second no longer push your real history out of the list.

Known limitation: older Manifest V2 extensions that block web requests (for example classic ad blockers installed from the Chrome Web Store or imported from another browser) are kept installed but not loaded, because on the current browser engine they stop pages from loading. The Extensions page shows the reason. The built-in ad blocker is not affected. Use the Manifest V3 version of such an extension where one exists.

On Linux, Vast uses the standard Electron 45.3.4 runtime. The patched runtime that provides full Chrome Web Store compatibility for extensions such as password managers is Windows-only for now. Video & Audio is Windows-only.

Installed 0.5.x Direct clients update automatically through `stable-v2.yml`. Linux AppImages update through `latest-linux.yml`. Portable and Microsoft Store installations use their own update paths.

The direct Windows installer, portable executable and standalone updater are intentionally unsigned. Windows may display Unknown publisher or SmartScreen warnings. Microsoft Defender may hold the first launch of a new build for up to a minute while it scans it. Microsoft Store uses a separate package and Store-managed updates.

The exhaustive formal password-manager gate is still open; this release does not claim every website or workflow is certified. Do not include vault contents, credentials, cookies or tokens in issue reports.
