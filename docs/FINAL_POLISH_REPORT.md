+# Vast 1.0.11 final polish implementation report

Date: 2026-07-22
Base Git commit: `5a47c632fa78cd21fe1b85af2d57b9ce72997577`

The repository had mixed pre-existing changes. Nothing was reset, cleaned, staged, committed, published, installed, or written into the production Vast profile by this work.

## Visual system and accessibility

Implemented one semantic token layer for canvas/surfaces, borders, primary/secondary/tertiary/disabled text, hover/active/success/warning/danger/info states, three shadow tiers, radii, controls, typography, focus, and motion. Legacy aliases remain so the migration does not require a destructive one-shot CSS rewrite.

- Functional UI copy now has a 13 px floor in the shared CSS and the autofill chooser.
- Keyboard focus rings are globally visible.
- `prefers-reduced-motion` disables animation/transition behavior.
- `prefers-reduced-transparency` and constrained-GPU detection reduce blur, saturation, and shadows.
- Light theme now uses opaque neutral surfaces, stronger borders, and no glass blur in Settings instead of milky translucent overrides.
- Dark and dim themes retain the Vast identity.

## Browser chrome

### Tabs

- Enforced minimum/maximum horizontal tab widths and clear active state.
- Close affordance is always present on the active tab and visible on hover/focus elsewhere.
- Pinned cards are separated and status indicators cover audio, download, error/crash, and sleep/discard state.
- Overflow menu includes search, domain, workspace, and tab count context.
- Drag targets show the insertion destination.
- Rich tooltips include domain/workspace context.
- Existing vertical layout remains available for high-tab-count users.

### New Tab

- Added minimalist, dashboard, and workspace-focused layouts.
- Added real favicons, draggable shortcut order, compact cards, hideable sections, recently closed pages, and workspace switching.
- Reduced empty-space behavior on smaller windows.

### Side panel and command palette

- Side panel supports persistent width, docked/overlay/auto modes, pin state, narrow-window behavior, labels/tooltips, proper tab ARIA semantics, and delete undo where applicable.
- Command palette now groups results, ranks favorites/recent usage, supports aliases and breadcrumbs, searches tabs/workspaces/notes/settings/bookmarks/history, and has responsive height and clear keyboard help.

## Product surfaces

### Downloads

Added pause, resume, cancel, retry, clear-completed, filter, speed, ETA, scan state/explanation, and copy-link. Files are still opened only after scan/hash completion.

### Site information

Shows true origin/internal-page distinction, HTTPS state, cookies/site data, permissions, blocker counts, clear-site-data, and a per-origin switch to disable Vast interventions. That switch is enforced in both request and renderer-injection paths.

### Notes

Added safe Markdown preview, autosave status, revision undo/redo, deletion undo, content search, pin/export, and URL/workspace association. Conflict handling remains local revision history rather than pretending to solve multi-device merge conflicts.

### Password manager

Added explicit locked/unlocked presentation, generator, strength feedback, weak/reused/duplicate audit, CSV import preview, per-domain Ask/Never autofill rules, usage metadata, native confirmation around secret copy/export, and clipboard clearing. Decryption/audit remain in the main process. Windows Hello is explicitly marked unavailable rather than simulated; stable biometric re-auth still needs a maintained native implementation.

Automatic capture now detects submitted login and registration forms on eligible HTTPS origins, asks in trusted Vast chrome before saving or updating, ignores unchanged credentials, and persists a reversible `Never for this site` preference. A scoped guest preload sends the candidate only to the host; the page receives no vault API. The main process revalidates the owning Vast window, exact webContents ID, and exact origin before accepting a capture. Google identity pages are excluded.

Autofill suggestions also discover forms added after page load by SPA frameworks. Suggestion UI receives metadata and an opaque credential ID only. A secret is decrypted in the main process and injected into the still-bound origin only after explicit selection; the optional second native confirmation remains enabled by default.

## Labs separation

- Network discovery defaults to disabled and requires explicit opt-in. It shows last scan, source, identification confidence, privacy/firewall onboarding, and confirmation before local device panels open.
- Video & Audio no longer auto-starts merely because its page was opened.
- Automation has dry run, permissions preview, a 25-action/30-second hard limit, drag ordering, per-step errors, activity log, single-run ownership, emergency stop, and explicit consent for auth/payment/vault targets.
- Automatic macro triggers are honestly shown as inactive safe-mode behavior rather than silently running.
- Reader is named **Focus Reader** because it applies reading styles; it does not claim article extraction or offline archiving.

## Backend and architecture hardening

- Central auth compatibility and automation-sensitive-target policies replaced scattered URL checks.
- Integrations and the dependent AI action surface were removed from Settings, preload, IPC, feature gates, diagnostics, and active runtime code. Existing legacy files are left untouched on disk and can still be preserved as other data by full backups.
- Vault operations retain origin and sender binding, main-process decryption, scoped preload, and local Labs feature gates.
- Per-site intervention exceptions apply coherently to request hooks and page scripts.
- Download runtime now owns active Electron download items and exposes bounded lifecycle actions.
- Redacted diagnostics were expanded without logging page content, tokens, credentials, or cookies.
- The release audit checks the non-mutating updater dry-run and confirms that the removed integration APIs are not part of the renderer surface through regression coverage.

## Updater verification and fixes

The updater test harness previously leaked its data-root lookup into the real `%APPDATA%\Vast` location. It now isolates `APPDATA` and `LOCALAPPDATA` per test. The active user profile is no longer a fixture.

The updater dry-run no longer creates `.vast-update` transactions or backups. Tests now cover:

- successful update and repair/hash path;
- dry-run with zero runtime mutation;
- downgrade rejection;
- version mismatch and incomplete payload rejection;
- locked runtime files;
- critical backup failure;
- forced mid-copy failure followed by rollback;
- data migration in isolated roots;
- bootstrapper release layout;
- public updater Free-only enforcement.

All updater suites pass.

## Verification summary

| Check | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm test` | PASS, 317/317 |
| `npm run build` | PASS |
| `npm run test:app` | PASS, 74/74 |
| `npm run test:updater` | PASS |
| `npm run release:audit` | PASS |
| Google provider acceptance | MIXED: user reports native login success; clean packaged Chromium-runtime flow was rejected; packaged native automation was inconclusive |
| Visual review | PASS for dark, dim, horizontal chrome, command palette, and revised light Settings |

## Deliberately deferred architecture changes

These were not mixed into a stability/final-polish sprint because they require migrations, rollback plans, and separate acceptance cycles:

- replacing JSON product data with SQLite;
- splitting the large main-process IPC module purely for file-size aesthetics;
- replacing every webview with `WebContentsView` in production;
- replacing packaged internal `file:` pages with a custom privileged protocol;
- changing Electron fuses without a packaged compatibility matrix;
- a real article-extraction/offline reader engine;
- Windows Hello native re-auth;
- automatic multi-device note conflict resolution.

The WebContentsView/performance work and full Chromium port remain preserved as separate checkpoints. None of these deferrals blocks the verified 1.0.11 behavior delivered here.
