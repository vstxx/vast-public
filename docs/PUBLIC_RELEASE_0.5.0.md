## What changed since 0.4.3

- Iframe permission checks and prompts use the requesting frame origin and reject missing or conflicting origin evidence.
- Guest-page wheel listeners remain passive to avoid blocking scrolling. Zoom remains available from the keyboard and browser controls.
- Includes the newer sidebar controls and transitions, tab reordering, fullscreen and appearance fixes.
- Includes Chrome Web Store navigation and extension installation improvements, plus the newer native extension runtime.
- Retains the 0.4.3 performance, styling and Store profile isolation changes.

Installed 0.4.3 Direct clients use `stable-v2.yml` for automatic updates. The legacy `latest.yml` remains pinned to the published 0.4.2 metadata because that version's installer handoff can fail. An installed 0.4.2 Direct client must run the 0.5.0 setup or standalone updater once. Portable and Microsoft Store installations use their own update paths.

The direct Windows installer, portable executable and standalone updater are intentionally unsigned. Windows may display Unknown publisher or SmartScreen warnings. Microsoft Store uses a separate package and Store-managed updates.

The exhaustive formal password-manager gate is still open; this release does not claim every website or workflow is certified. Do not include vault contents, credentials, cookies or tokens in issue reports.
