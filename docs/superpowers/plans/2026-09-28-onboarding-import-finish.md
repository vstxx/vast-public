# Onboarding Import Finish and Release Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the 0.4.0 onboarding behavior around the transactional importer and verify it in a real Electron runtime without claiming untested source profiles or extensions as passing.

**Architecture:** Plans 1 and 2 provide the main-owned data/extension transactions. This plan makes onboarding choices declarative until final confirmation, adjusts new-profile defaults and scoped UI behavior, then runs fixture and actual-profile validation with a written result ledger.

**Tech Stack:** React/TypeScript, Zustand, Electron 44, electron-vite, Node tests/E2E, pinned patched ECE runtime.

**Spec:** `docs/superpowers/specs/2026-09-28-transactional-browser-import-design.md`; depends on `docs/superpowers/plans/2026-09-28-browser-import-data.md` and `docs/superpowers/plans/2026-09-28-chromium-extension-transfer.md`.

## Global Constraints

- Existing users' settings, bookmarks, extensions and migration behavior remain unchanged unless they explicitly choose a new setting/import.
- Adblocker is optional. No extension (including Hub recommendations) installs/enables before final confirmation and its own permission approval.
- New Tab plain text is search; address-bar aliases and explicit `vast://` remain.
- Logos are bundled locally only after license/trademark provenance review. UI copy never calls local Chromium imports Official/Verified.
- No release PASS without actual Electron E2E, lint/typecheck, unit/integration/security regressions, and honest untested-case reporting.

## Review Focus

- “Use defaults” on a fresh profile must turn on Clean Toolbar Icons and all listed Labs including Spoofing, without launching a network scan (Task 1 test).
- Migrating an old profile with missing `cleanToolbarIcons` must not silently switch its existing appearance (Task 1 test).
- Typing `onboarding` in New Tab must search, while the address bar shortcut and explicit `vast://onboarding` still open the internal page (Task 2 test).
- A Hub recommendation clicked during onboarding must remain only a selection until final confirmation, and Back/Fresh start must leave it uninstalled (Task 4 test).
- An E2E test failure due to an absent actual Firefox profile must be recorded `untested`, not substituted with fixture PASS (Task 6 ledger).

---

### Task 1: New-profile defaults and Labs guardrails

**Files:** Modify `src/shared/constants.ts`, `src/shared/onboarding.ts`, `src/main/storage.ts`, `src/renderer/components/onboarding/OnboardingPage.tsx`; test `tests/renderer/onboarding-store.test.ts`, `tests/main/storage-upgrade-url-migration.test.ts`, `tests/renderer/onboarding-routing.test.ts`.

**Interfaces:** `onboardingDefaultChoices()` adds `cleanToolbarIcons: true` and `labs: {enabled:true, avidae:true, automation:true, networkDevices:true, advancedDiagnostics:true, spoofing:true}` for a new profile. Storage migration distinguishes `new` from `existing with field absent`; prior persisted appearance/Labs values are preserved.

- [ ] Write tests for new profile, Use defaults, Configure route, legacy missing field, all Labs switches including Spoofing, individual security gates and no automatic network scan.
- [ ] Run targeted tests; expect FAIL for current false defaults/missing Spoofing.
- [ ] Implement new-profile-only defaults and complete Labs list; keep each Labs feature's existing activation gate and scanning user action separate.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 1 files.

### Task 2: New Tab input context

**Files:** Modify `src/renderer/lib/url.ts`, `src/renderer/components/new-tab/NewTabPage.tsx`; test `tests/renderer/onboarding-routing.test.ts`; create `tests/renderer/new-tab-search.test.ts`.

**Interfaces:** `resolveNewTabInput(input: string, searchEngineId: string): string` treats bare aliases as search terms and delegates explicit `vast://` to safe internal routing. Existing `resolveAddressInput` retains address-bar behavior.

- [ ] Write tests for `avidae`, `onboarding`, a normal query, a URL, and explicit `vast://` in New Tab vs address bar.
- [ ] Run targeted tests; expect FAIL on current New Tab alias routing.
- [ ] Implement context-specific input resolution without changing address-bar aliases.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 2 files.

### Task 3: Local logos and Settings navigation alignment

**Files:** Modify `src/renderer/components/onboarding/OnboardingPage.tsx`, `src/renderer/components/onboarding/OnboardingImportStep.tsx`, `src/renderer/styles/index.css`; create reviewed assets/provenance under `src/renderer/assets/onboarding/`; test `tests/renderer/onboarding-branding.test.ts`; modify `scripts/browser-import-data-e2e.cjs` for visual smoke checks.

**Interfaces:** Local logo lookup maps only known Chrome/Edge/Firefox and configured search-engine IDs, with text/icon fallback. No external image fetch is added.

- [ ] Write tests for logo fallback/offline render and computed-style/visual Settings navigation typography/alignment at common densities (no CSS source-string assertions).
- [ ] Run targeted tests and visual E2E; expect FAIL.
- [ ] Obtain official brand assets only from redistribution-compatible sources, record provenance/licenses with the assets, and bundle locally. Adjust `.settings-nav-item` font/icon size, alignment and spacing without changing unrelated controls.
- [ ] Run targeted tests, `npm run lint`, a renderer build and visual smoke check; expect PASS. Commit Task 3 files.

### Task 4: Honest onboarding extension recommendations and results

**Files:** Modify `src/renderer/components/onboarding/OnboardingExtensionsStep.tsx`, `src/renderer/components/onboarding/OnboardingPage.tsx`, `src/shared/onboarding.ts`, `src/shared/browser-import.ts`, `src/renderer/styles/index.css`; test `tests/renderer/onboarding-store.test.ts`, `tests/renderer/onboarding-routing.test.ts`; modify `scripts/browser-import-extensions-e2e.cjs` from Plan 2.

**Interfaces:** The recommendation step consumes `VastHubCatalogItem.summary` (and details when available), records selected Hub IDs only, and schedules each `prepareHubInstall`/consent/`confirmInstall` after Plan 1's data commit. The final receipt shows actual bookmark/history counts and independent local/Hub extension statuses; a declined/failed extension never changes data receipt.

- [ ] Write tests for six bounded recommendations with real descriptions, no fake “Verified” for unverified publisher, selection then Back/Fresh start/no install, final separate Hub consent, offline Hub, and no default Adblocker installation.
- [ ] Run targeted tests; expect FAIL because current click calls `confirmInstall` immediately and cards lack descriptions.
- [ ] Replace early installation with selected state; apply existing Hub signed-package flow only after final commit, with separate consent and no auto-grants. Show installed/partial/unsupported/failed/skipped counts from durable receipts, not optimistic clicks.
- [ ] Run targeted tests, Electron extension E2E, `npm run lint`; expect PASS. Commit Task 4 files.

### Task 5: Controlled Electron onboarding E2E matrix

**Files:** Modify `scripts/browser-import-data-e2e.cjs` and `scripts/browser-import-extensions-e2e.cjs`; create `scripts/browser-import-fixtures.cjs`; modify `package.json` test scripts; test `tests/main/import-coordinator.test.ts`, `tests/main/import-extension-install.test.ts`.

**Interfaces:** `npm run test:import:e2e` launches the pinned patched Vast binary with a throwaway Vast profile and controlled Chrome/Edge/Firefox fixtures. The runner emits a machine-readable result ledger with `pass | fail | untested` per scenario and retains sanitized logs. Cleanup targets only its validated temporary roots.

- [ ] Write failing E2E assertions for Prepare→Preview→Commit disk timing, app crash/restart, Retry, Back/Next, full/partial categories, Firefox actual visits, active WAL, 8 MiB rejection, permission denial, local MV2/MV3 transfer, runtime reload and extension collision.
- [ ] Run `npm run test:import:e2e`; expect FAIL while integration is incomplete.
- [ ] Implement fixture generator/runner and dual dev/packaged entry checks. Do not log source URLs/titles, credential data or extension payloads; never mutate real source profiles.
- [ ] Run `npm run test:import:e2e`, `npm run test:extensions:e2e`, `npm run lint`, `npm test`; expect PASS. Commit Task 5 files.

### Task 6: Actual-profile audit and release evidence

**Files:** Create `docs/releases/VAST-0.4.0-IMPORT-VALIDATION.md`; modify only defects proven by this gate, with a regression test in the owning task's file before each fix.

**Interfaces:** The validation ledger names source/browser version, open/closed state, selected categories, operation result, actual persisted counts, extension consent/runtime result, restart result, test command, and `pass | fail | untested` without sensitive profile content. Real-profile checks are read-only on source browsers and use an isolated Vast destination.

- [ ] Inventory locally available Chrome, Edge and Firefox profiles without exposing URLs, titles, passwords, cookies, tokens or extension private data. Record absent browsers/profiles as `untested`.
- [ ] With a safe test window, run real-profile closed and active-browser/WAL imports for each available source. Verify source file hashes/mtime are unchanged where feasible, Vast persistence/restart, and selected extension install/permissions/runtime. If a source cannot be safely opened or automated, mark that case `untested`, not PASS.
- [ ] Run full `npm run lint`, `npm test`, `npm run test:import:e2e`, `npm run test:extensions:e2e`, `npm run release:audit`, and relevant packaged smoke tests. Record exact exit codes, artifact/runtime fingerprint, failures and gaps.
- [ ] Review security invariants, migrations and changed-file list; write the ledger and commit it. Do not call the importer or 0.4.0 release-ready while required tests remain failed or unverified.
