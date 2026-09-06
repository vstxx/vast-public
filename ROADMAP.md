# Vast Roadmap

This roadmap describes engineering direction, not promised release dates. Items move when they are implemented, rejected, or superseded.

## Current priorities

- Keep tab lifecycle, smart unloading, scrolling, startup, and memory behavior predictable under large sessions.
- Keep public source snapshots, Windows releases, updater metadata, checksums, and third-party source obligations reproducible and easy to audit.
- Continue hardening extensions, password-vault, IPC, navigation, and Labs trust boundaries without adding unnecessary backend complexity.
- Keep Windows direct and Microsoft Store distribution behavior consistent, including profile migration and update boundaries.
- Reduce default distribution/runtime weight where it can be done without weakening offline behavior, compatibility, or verification.

## Next

- Continue evaluating `WebContentsView` as a future browser-content backend where it provides measurable benefits over webviews without losing required browser behavior.
- Improve storage scalability, recovery, and migration while preserving straightforward export/import and rollback paths.
- Expand per-site controls and visibility into permissions, data, interventions, and resource state.
- Refine fresh-profile onboarding and workspace setup without seeding unwanted personal content.
- Continue improving extension compatibility and first-party extension integration.

## Exploring

- Release-quality macOS and Linux support once those platforms can be continuously verified.
- A local plugin/command contribution model with explicit capabilities.
- Optional local-model integrations that do not require a Vast account or remote entitlement service.
- The experimental upstream-Chromium port under `chromium-port/` as a separate long-term architecture track.

Completed work should be removed from this file rather than kept as a historical checklist; Git history already records it.
