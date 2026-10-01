## Vast 0.4.2 hotfix

This release removes a non-passive wheel listener from the guest-page preload. In Vast 0.4.1 that listener could delay scrolling on heavy pages, including Gmail and ChatGPT. The remaining guest wheel listener is passive.

This hotfix also removes Vast's custom Ctrl/Meta+wheel zoom forwarding from website webviews. Keyboard and browser UI zoom controls are unchanged.

The Electron 44.3.0 / ECE 4.9.0 compatibility runtime and the password-manager extensions are unchanged. The exhaustive formal password-manager gate is still open; its full acceptance matrix was not rerun for this narrowly scoped hotfix.

The direct Windows installer, portable executable and updater are intentionally unsigned. Windows can display Unknown publisher or SmartScreen warnings. Microsoft Store uses a separate MSIX submission and Store-managed updates.

The release assets include SHA-256/SHA-512 checksums and exact source provenance. Verify downloaded files against the published checksums. Existing direct profiles are preserved by the normal update path; back up important data before changing distribution channels.
