## What changed since 0.4.2

- Reduced avoidable work during startup, first page load, Settings and sidebar updates. Background tab retention and manual sleep handling were adjusted to avoid unnecessary reloads.
- Improved guest-page scroll responsiveness, including nested Purist scrolling. The guest wheel listeners remain passive; browser zoom remains available through the keyboard and browser UI.
- Fixed the opening splash so the Vast wordmark is fully visible. The splash timing and packaged startup path were measured and reviewed.
- Updated the renderer styling toolchain to Tailwind CSS 4.3.3, removed the vulnerable `braces` dependency chain from the build, and preserved the existing theme and geometry. The New Tab search icon remains visible above its input surface.
- Updated the Electron 44.3.0 Vast compatibility runtime to the pinned r5 release-profile build and retained the ECE 4.9.0 extension runtime. Extension and adblock behavior must pass the release candidate gates before publication.
- Isolated Microsoft Store profile data from direct Vast installations and tightened browser-import and managed-extension path handling.

The direct Windows installer, portable executable and updater are intentionally unsigned. Windows may display Unknown publisher or SmartScreen warnings. Microsoft Store uses a separate MSIX submission and Store-managed updates.

Release assets include SHA-256/SHA-512 checksums and source provenance. The 0.4.2 automatic updater can download a new release but can fail when it hands the installer off at next startup. For safety, 0.4.3 keeps `latest.yml` pinned to the published 0.4.2 metadata. Existing 0.4.2 direct-install users must run the 0.4.3 setup or standalone updater once; their profile is preserved. Vast 0.4.3 and later use `stable-v2.yml` for subsequent automatic updates. Keep both feeds in future stable releases until the legacy population is retired through an explicitly tested migration. The exhaustive formal password-manager gate is still open; its full acceptance matrix is not claimed as complete here.
