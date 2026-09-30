## What changed since 0.3.0

- Added the source-controlled Electron 44.3.0 / ECE 4.9.0 Chrome-extension compatibility runtime and one Extension Hub for installation and management.
- Added Hub installation for upstream Bitwarden and Proton Pass packages, preserving their extension IDs. iCloud Passwords is retrieved from Apple's Chrome Web Store listing with its original ID; Vast does not host or repackage it.
- Updated the separate Adblocker for Vast extension and made extension popup menus resizable in width and height.
- Added Clean toolbar icons and aligned Settings typography. The optional Purist layout and other interface changes remain subject to their normal feature gates.
- Pinned compatibility source patches, the approved Electron binary fingerprint, release-source provenance, and GPL corresponding-source material.

Password-manager testing used controlled accounts and fixtures. The exhaustive formal password-manager gate is still open; this release does not claim every website or workflow is certified. Please report reproducible issues without sharing vault contents.

The installer is for a normal direct installation. Portable is a separate copy. The standalone updater is only for an existing direct installation, not Microsoft Store/MSIX or Portable. Microsoft Store availability requires a separate package, certification, and rollout.

These direct Windows binaries are intentionally unsigned; Windows can display Unknown publisher or SmartScreen warnings.

The release assets include SHA-256/SHA-512 checksums and exact source provenance. Verify a downloaded executable against the published checksums before running it. Existing profiles and extensions are preserved by the normal direct update path; back up important data before switching distribution channels.
