## What changed since 0.5.0

- Runs on a patched Electron 45.0.0 (Chromium 156.0.8078.48) with the Vast extension-compatibility patch set.
- Chrome Web Store pages open normally inside Vast, and extensions can be installed from a store listing with **Install in Vast**. 0.5.0 kept store navigation guarded; that guard is lifted for the verified 0.5.4 runtime.
- Calling apps (Google Meet, Zoom, Microsoft Teams and similar) can ask for the camera and microphone. After you allow them, the site sees your devices for the rest of the visit.
- Visual Profiles: save, apply, import and export appearance settings as `.vastvisual` files. They replace the Appearance live preview.
- New appearance options: background blur, transparency and frost for floating surfaces; a neutral dark theme; the accent color drives the UI highlight color.
- Scrollable horizontal tab strip, a unified compact sidebar, and smoother tab closing and reordering.
- Custom New Tab wallpapers display at any image size.
- Address bar suggestions open only after you type.
- Faster startup with many tabs or extensions, and smoother Settings, side panel and sidebar.
- The Extensions Hub lists every extension on the website and matches the new site design.

Known limitation: older Manifest V2 extensions that block web requests (for example classic ad blockers installed from the Chrome Web Store or imported from another browser) are kept installed but not loaded, because on the new browser engine they stop pages from loading. The Extensions page shows the reason. The built-in ad blocker is not affected. Use the Manifest V3 version of such an extension where one exists.

Installed 0.5.0 Direct clients update automatically through `stable-v2.yml`. Portable and Microsoft Store installations use their own update paths.

The direct Windows installer, portable executable and standalone updater are intentionally unsigned. Windows may display Unknown publisher or SmartScreen warnings. Microsoft Defender may hold the first launch of a new build for up to a minute while it scans it. Microsoft Store uses a separate package and Store-managed updates.

The exhaustive formal password-manager gate is still open; this release does not claim every website or workflow is certified. Do not include vault contents, credentials, cookies or tokens in issue reports.
