# Local Chromium Extension Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer eligible Chrome/Edge extension directories into Vast 0.4.0 without editing their code, bypassing consent, or conflating local copies with Hub/upstream packages.

**Architecture:** The importer discovers source-profile metadata, stages bounded byte-for-byte copies, validates identity and permissions, then installs each selected extension independently after Plan 1's data commit. The extension manager reuses its managed rollback/runtime path but has a distinct `local-chromium` source and `Local / Unverified` trust. Firefox extension import remains disabled.

**Tech Stack:** Electron 44/ECE 4.9.0 pinned runtime, TypeScript, Node filesystem/crypto, existing ExtensionManager/managed store, Node tests and isolated Electron E2E.

**Spec:** `docs/superpowers/specs/2026-09-28-transactional-browser-import-design.md`; depends on `docs/superpowers/plans/2026-09-28-browser-import-data.md`.

## Global Constraints

- Chrome/Edge original directories only; no code/manifest modification, `.vext` conversion, Hub-equivalent requirement, or automatic update-channel attachment.
- No cookies, tokens, password vaults, `Local Extension Settings`, IndexedDB, private storage, or Firefox extensions copied.
- Imported code is `Local / Unverified`, never `Official`/`Verified Publisher`; no Vast Native grant or execution before explicit required-permission consent.
- Keyless/mismatched runtime ID is `unsupported` for 0.4.0; a collision is `already installed`, never overwrite. Partial API compatibility alone does not block safe import.
- A single extension failure cannot roll back Plan 1's bookmarks/history or another extension's success.

## Review Focus

- A copied directory with a symlink/junction to a vault or file outside its root must fail before any read/copy (Task 2 test).
- Source `manifest.key` whose ID differs from `Preferences` must be `unsupported`, not installed under either ID (Task 3 test).
- A user declining host access must leave no enabled registry entry or running worker (Task 4 test).
- A local copy must never replace a same-ID Hub/upstream/unpacked install or acquire its update channel (Task 4 test).
- A source extension whose files change between inventory and copy must fail and be retryable without a partial permanent copy (Task 2 test).

---

### Task 1: Profile extension metadata and selection

**Files:** Modify `src/shared/browser-import.ts`, `src/main/import/profile-discovery.ts`, `src/main/import/source-worker.ts`, `src/main/browser-import.ts`; create `src/main/import/chromium-extension-discovery.ts`; test `tests/main/import-extension-discovery.test.ts`.

**Interfaces:** `DetectedChromiumExtension = { id: string; name: string; version: string; sourceEnabled: boolean; manifestVersion: 2|3; state: 'detected'|'unsupported'|'failed'; limitationCodes: string[]; fingerprint: string }` extends Plan 1's `DetectedExtensionInfo` (`id` is the Chromium source extension ID). `discoverChromiumExtensions(profilePath): Promise<DetectedChromiumExtension[]>` is worker-only. The main coordinator stores canonical source roots privately; renderer gets IDs/metadata, never paths.

- [ ] Write tests for Chrome/Edge `Preferences.extensions.settings` state, locale names, disabled/externally installed items, version-directory mismatch, missing manifest, >200 entries, malformed JSON, and Firefox selector exclusion. Assert no private extension storage read.
- [ ] Run `node --test tests/main/import-extension-discovery.test.ts`; expect FAIL.
- [ ] Implement bounded metadata parsing (`Preferences` maximum 32 MiB) and source-ID/version/directory reconciliation. Do not infer `enabled` from directory existence. Include per-item detected/unsupported/failed status.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 1 files.

### Task 2: Safe immutable raw-directory staging

**Files:** Create `src/main/extensions/local-chromium-stage.ts`; modify `src/main/extensions/extension-managed-store.ts`, `src/shared/extension-marketplace.ts`; test `tests/main/local-chromium-stage.test.ts`, `tests/main/extension-managed-store.test.ts`.

**Interfaces:** `stageLocalChromiumDirectory(input: {sourceRoot: string; sourceExtensionId: string; expectedVersion: string; stagingRoot: string}, signal: AbortSignal): Promise<LocalChromiumStage>` returns `{contentRoot, sourceExtensionId, version, fingerprint, fileCount, byteCount}`. `ExtensionInstallSource` adds `'local-chromium'`. `StagedManagedPackage` becomes a discriminated union: existing `{format:'vext'; parsed:ParsedVextPackage}` or `{format:'local-chromium'; sourceExtensionId; version; fingerprint; manifestSha256}`; both expose `contentRoot`. Managed state/commit handles the second without a `.vext` parser/signature and stores metadata outside `contentRoot`.

- [ ] Write tests for traversal, symlink/junction/reparse points, case-insensitive path collision, nested/oversized/too-many files, changed source during copy, cancellation, startup cleanup, copied-byte hash equality, and explicit absence of private storage files.
- [ ] Run `node --test tests/main/local-chromium-stage.test.ts tests/main/extension-managed-store.test.ts`; expect FAIL.
- [ ] Implement regular-file-only inventory and byte-for-byte copy with `lstat`/`realpath` containment checks, per-file SHA-256 and post-copy source recheck. Cap at 10,000 files, 256 MiB total, 32 MiB/file, depth 16 and 30 seconds; metadata never enters copied extension root. Distinct managed-source state must not be mistaken for `local-vext`, Hub, or upstream.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 2 files.

### Task 3: Identity, manifest and compatibility gate

**Files:** Modify `src/main/extensions/extension-manifest.ts`, `src/main/extensions/extension-compatibility.ts`, `src/main/extensions/extension-types.ts`; create `src/main/extensions/local-chromium-validation.ts`; test `tests/main/extension-manifest.test.ts`, `tests/main/local-chromium-validation.test.ts`, `tests/main/extension-compatibility.test.ts`.

**Interfaces:** `validateLocalChromiumStage(stage: LocalChromiumStage, sourceExtensionId: string): Promise<{validated: ValidatedExtensionManifest; runtimeId: string; permissions: ExtensionPermissionSnapshot; compatibility: 'compatible'|'partial compatibility'|'unsupported'; limitations: string[]}>`. It requires a valid `manifest.key` with `chromeExtensionId(stage.contentRoot, validated.manifest.key) === sourceExtensionId`, then rechecks the same identity from the permanent copy and actual Electron load after consent; no-key/mismatch is `unsupported` without manifest rewrite.

- [ ] Write tests for valid keyed MV3; no key, malformed key and wrong ID; missing content script/background/popup assets; unsafe CSP/path/permissions; MV2 content-script fixture; attempted `vast_network`/document-rule privilege; known missing API reported as partial/unsupported without false `supported` claim.
- [ ] Run targeted tests; expect FAIL on ordinary MV2 and identity-policy gaps.
- [ ] Reuse the existing manifest/compatibility analyzers, but add a local-channel policy gate. Remove ordinary-MV2 blanket rejection only for validated local Chromium copies; preserve privileged Vast network-provider rules. If pinned Electron rejects MV2 at load, classify it `unsupported` and do not claim MV2 compatibility.
- [ ] Run targeted tests, `npm run lint`; expect PASS. Commit Task 3 files.

### Task 4: Consent-gated independent managed activation

**Files:** Modify `src/main/extensions/extension-manager.ts`, `src/main/extensions/extension-managed-store.ts`, `src/main/extensions/extension-registry.ts`, `src/main/extensions/extension-types.ts`, `src/shared/extension-marketplace.ts`, `src/shared/types.ts`, `src/main/import/import-coordinator.ts`, `src/main/ipc.ts`, `src/preload/index.ts`; test `tests/main/extension-manager.test.ts`, `tests/main/import-extension-install.test.ts`.

**Interfaces:** `ExtensionManager.prepareLocalChromiumImport(source: {sourceBrowserId: BrowserImportSourceId; profileId: string; sourceExtensionId: string; version: string; fingerprint: string}): Promise<ExtensionPackagePreview>` and `.confirmLocalChromiumImport(token: string, approval: {chrome: string[]; hosts: string[]; vast: []}): Promise<VastExtensionInfo>`. Coordinator exposes `installSelectedExtension(operationId, sourceExtensionId, approval): Promise<ImportExtensionReceipt>` only after its durable data receipt exists. `ImportExtensionReceipt.status = 'installed'|'partial compatibility'|'unsupported'|'failed'|'already installed'|'declined'`.

- [ ] Write tests for no activation before approval, exact required Chrome/host grants, optional grants not automatic, zero Vast Native grants, duplicate across every source channel, disabled source remains disabled, load failure rollback, crash/restart recovery, and independent multi-extension outcomes.
- [ ] Run targeted tests; expect FAIL.
- [ ] Add the distinct managed source and consent token, revalidate copied bytes/manifest/permissions at activation, persist an immutable trust/channel record, enforce grants at runtime, and activate with existing rollback semantics. Reject replay and cross-profile token use. Never route through developer `installUnpacked`.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 4 files.

### Task 5: Transfer UI, persistence and real runtime E2E

**Files:** Modify `src/renderer/components/onboarding/OnboardingPage.tsx`, `src/renderer/components/onboarding/OnboardingImportStep.tsx`, `src/renderer/components/extensions/ExtensionsPage.tsx`, `src/shared/browser-import.ts`, `src/shared/onboarding.ts`; create `src/renderer/components/onboarding/OnboardingExtensionConsent.tsx`, `scripts/browser-import-extensions-e2e.cjs`; test `tests/renderer/onboarding-store.test.ts`, `tests/main/import-extension-install.test.ts`.

**Interfaces:** Renderer consumes Plan 1's `extensions-pending` phase and Task 4's per-extension preview/receipt. Consent displays source browser, source ID/version/state, `Local / Unverified`, requested permissions, concrete compatibility limitations and Install/Skip. Restart resumes pending choices by ID/fingerprint; changed source requires a fresh preview/consent.

- [ ] Write renderer tests for decline, Retry, crash/resume, selected extension failure while data stays committed, statuses and trust labels. Create controlled Chrome and Edge MV2/MV3 extension profiles; Electron E2E installs with explicit permission confirmation, checks actual popup/content script/worker behavior, disabled state, restart, no private data, and same-ID collision.
- [ ] Run targeted tests and `node scripts/run-isolated-electron-e2e.cjs browser-import-extensions-e2e.cjs`; expect FAIL before implementation.
- [ ] Implement consent/resume UI and local-source details without Hub/official attribution. Persist only final verified receipts; display untested API paths as unknown/limitations, not PASS.
- [ ] Run targeted tests, E2E, `npm run lint`, `npm test`; expect PASS. Commit Task 5 files.
