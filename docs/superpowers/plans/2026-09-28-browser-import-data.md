# Browser Import Data Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chrome, Edge, and Firefox bookmark/history import previewable, bounded, durable, idempotent, and truthful before any extension transfer.

**Architecture:** Main owns discovery, one prepared snapshot, and an atomic storage commit. A separately bundled worker reads untrusted browser files and SQLite snapshots; renderer only displays opaque preview/receipt values. Storage revisions prevent queued renderer autosaves from overwriting committed import data.

**Tech Stack:** Electron 44, TypeScript, Node 24 `node:sqlite`/`worker_threads`, electron-vite, Zustand, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-28-transactional-browser-import-design.md`

## Global Constraints

- Sources: Chrome, Edge, Firefox only; no password, cookie, token, vault, private extension storage, or Firefox extension import.
- History retention: 1,000 entries; storage maximum: 8 MiB including the import receipt.
- No source profile/database mutation, silent category narrowing, renderer-owned import write, or Electron source rebuild without a reproduced reason.
- Existing profile data/migrations and unrelated storage fields must survive. Logs contain only category/count/timing/error code, not URLs, titles, payloads, or secrets.
- Plan 2 consumes the import contracts and adds Chromium extension transfer; Plan 3 connects final onboarding UI and E2E.

## Review Focus

- A renderer save queued just before commit must not restore pre-import bookmarks after commit (Task 5 test).
- A rename that succeeds while the acknowledgement fails must return the prior receipt on Retry (Task 5 test).
- A Firefox bookmark with no `moz_historyvisits` row must not appear in history (Task 3 test).
- An active WAL with a locked/corrupt source must yield a consistent snapshot or a retryable error, never a partial read (Task 2 test).
- Two same-URL bookmarks in distinct roots/folders must retain separate IDs through restart and delete-by-ID (Task 4 test).

---

### Task 1: Import contracts and profile discovery

**Files:** Modify `src/shared/browser-import.ts`, `src/shared/types.ts`, `src/main/browser-import.ts`; create `src/main/import/profile-discovery.ts`; test `tests/main/browser-import.test.ts`, `tests/main/import-profile-discovery.test.ts`.

**Interfaces:** `BrowserImportPrepareRequest = { sourceId: BrowserImportSourceId; profileId: string; types: BrowserImportDataType[] }`; `BrowserImportCategoryResult.status = 'ready' | 'empty' | 'unavailable' | 'failed'`; `ResolvedImportSource = {sourceId; profileId; canonicalPath}` is main/worker-only; `resolveImportProfile(sourceId, profileId): Promise<ResolvedImportSource>` accepts only an ID returned by discovery. `discoverImportSources(): Promise<BrowserImportCatalog>` remains the public discovery method. No arbitrary source path enters IPC.

- [ ] Write tests: bounded `Local State` names/fallback; `profiles.ini` relative and absolute Firefox paths; duplicate or malicious profile IDs, symlink/junction escapes, and Firefox `extensions` disabled. Assert the source path is never returned to renderer.
- [ ] Run `node --test tests/main/browser-import.test.ts tests/main/import-profile-discovery.test.ts`; expect the new cases to fail.
- [ ] Implement canonical-path discovery and revalidation in `profile-discovery.ts`; cap `Local State` at 4 MiB and `profiles.ini` at 1 MiB. Keep `browser-import.ts` as a compatibility re-export only until callers migrate.
- [ ] Run the targeted tests and `npm run lint`; expect PASS. Commit only Task 1 files.

### Task 2: Bounded off-main-thread SQLite snapshots

**Files:** Create `src/main/import/source-worker.ts`, `src/main/import/worker-client.ts`, `src/main/import/sqlite-snapshot.ts`; modify `electron.vite.config.ts`, `src/main/browser-import.ts`; test `tests/main/import-sqlite-snapshot.test.ts`, `tests/main/import-worker.test.ts`.

**Interfaces:** `readBrowserSource(source: ResolvedImportSource, types: readonly BrowserImportDataType[], signal: AbortSignal): Promise<BrowserSourceSnapshot>` runs in a worker and returns capped arrays plus per-category errors. `withSqliteSnapshot<T>(sourcePath: string, read: (db: DatabaseSync) => T): Promise<T>` performs read-only online backup, `PRAGMA quick_check`, and cleanup. `BrowserSourceSnapshot` is defined in `src/shared/browser-import.ts` and contains `bookmarks`, `history`, `extensions`, and `categories`.

- [ ] Write tests for an open SQLite WAL with uncheckpointed visits; a corrupt/locked DB; missing or unreadable WAL; a worker timeout/cancel; oversized DB; and cleanup after a simulated process restart. Verify Firefox bookmark/history readers receive the same snapshot path.
- [ ] Run `node --test tests/main/import-sqlite-snapshot.test.ts tests/main/import-worker.test.ts`; expect FAIL.
- [ ] Add a named `browser-import-worker` main build input, start it from packaged and dev output, bound worker wall time to 30 seconds and source DB to 512 MiB, and terminate/clean up on cancel. Reject if read-only online backup is unavailable; never fall back to separate DB/WAL/SHM copies.
- [ ] Run targeted tests, `npm run build`, and a packaged-path worker smoke test; expect PASS. Commit Task 2 files.

### Task 3: Correct bounded source readers

**Files:** Create `src/main/import/bookmark-reader.ts`, `src/main/import/history-reader.ts`; modify `src/shared/browser-import.ts`, `src/main/browser-import.ts`, `src/main/import/source-worker.ts`; test `tests/main/browser-import.test.ts`, `tests/main/import-readers.test.ts`.

**Interfaces:** `ImportedBookmarkEntry` adds `sourceItemId: string` and `root: 'bar' | 'other' | 'mobile' | 'menu' | 'unfiled'`; `ImportedHistoryEntry` keeps URL/title/count/time. `readChromiumBookmarks`, `readFirefoxBookmarks`, `readChromiumHistory`, `readFirefoxHistory` each return `{items, skipped, error?}` with caps and deterministic order.

- [ ] Write tests for Chrome/Edge Bar/Other/Mobile nesting, Firefox `moz_bookmarks_roots`, duplicate URLs in different folders, malformed cycles/depth, actual Firefox visits, NULL/negative/overflow timestamps, stable tie ordering, 1,000-history cap, row and file limits.
- [ ] Run targeted tests; expect FAIL on current flat roots, URL dedupe and zero-visit coercion.
- [ ] Implement iterative bounded folder traversal (depth 6, 5,000 bookmarks, 1,000 folders), cap Chromium `Bookmarks` JSON at 32 MiB, parameterized limited SQL, strict timestamp conversion, and per-category counts. Read Firefox bookmarks/history from the Task 2 snapshot; avoid unbounded `.all()`.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 3 files.

### Task 4: ID-based bookmark model and pure candidate merge

**Files:** Modify `src/shared/types.ts`, `src/renderer/store/browser-store.ts`, `src/renderer/store/imported-data-merge.ts`, `src/renderer/app/App.tsx`, `src/renderer/components/browser/AddressBar.tsx`, `src/main/storage.ts`; create `src/main/import/import-merge.ts`; test `tests/renderer/onboarding-store.test.ts`, `tests/main/import-merge.test.ts`, `tests/main/storage-upgrade-url-migration.test.ts`.

**Interfaces:** `mergeImportCandidate(current: PersistedData, snapshot: BrowserSourceSnapshot, selected: readonly BrowserImportDataType[]): {data: PersistedData; counts: Record<'bookmarks'|'history', {added:number; updated:number; skipped:number; failed:number}>}` is pure. `Bookmark.importSource?: { browser: BrowserImportSourceId; profileId: string; itemId: string }` and `BookmarkFolder.importSource?: {browser; profileId; root; itemId}` are optional and migration-safe; all bookmark mutations identify records by `Bookmark.id`. Source Bar/Firefox toolbar children map to Vast bar root (no synthetic toolbar folder); Other/Mobile/Menu/Unfiled get distinct, provenance-keyed top-level folders.

- [ ] Write tests: preserve same-URL records across folders/restart, reimport by provenance is idempotent, delete/update only the selected ID, `visitCount=max`, deterministic top 1,000, report evictions/skips, preserve existing unrelated fields, and fail 8 MiB preflight without truncation.
- [ ] Run targeted tests; expect FAIL on URL-only dedupe, summed visits and 1,100 reported additions.
- [ ] Implement ID/provenance model and pure main merge. Update URL-based toggle semantics only for the current tab's own bookmark action; never use URL to delete an arbitrary duplicate. Keep existing bookmark IDs during migration and remove renderer import mutation.
- [ ] Run targeted tests and `npm run lint`; expect PASS. Commit Task 4 files.

### Task 5: Durable storage mutation and generation fencing

**Files:** Modify `src/main/storage.ts`, `src/shared/onboarding.ts`, `src/shared/browser-import.ts`, `src/shared/types.ts`, `src/renderer/store/browser-store.ts`; test `tests/main/import-storage-commit.test.ts`, `tests/main/download-storage-concurrency.test.ts`, `tests/main/storage-read-retry.test.ts`.

**Interfaces:** `BrowserImportCommitReceipt` in `src/shared/browser-import.ts` carries operation ID and actual per-category added/updated/skipped/failed counts. `PersistedData.importState` carries monotonic `generation`, bounded prior `receipt`, and onboarding phase (`idle | extensions-pending | completed`); pending extension IDs are reserved for Plan 2. `commitImportData(operationId: string, merge: (current: PersistedData) => {data: PersistedData; receipt: BrowserImportCommitReceipt}): Promise<{data: PersistedData; receipt: BrowserImportCommitReceipt; generation: number}>` writes and readback-verifies one candidate. Existing `saveRendererData(data: PersistedData)` rejects saves whose `data.importState?.generation` is stale (legacy missing value is generation 0).

- [ ] Write tests for a queued renderer save racing commit, main-owned downloads, 8 MiB rejection, forced write/readback/flush failure, rename-success/ACK-loss, and idempotent receipt lookup after restart.
- [ ] Run `node --test tests/main/import-storage-commit.test.ts tests/main/download-storage-concurrency.test.ts tests/main/storage-read-retry.test.ts`; expect new cases FAIL.
- [ ] Serialize all storage mutations through one queue, add generation fencing to renderer saves, write an atomic candidate plus receipt, read it back before returning success, and reconcile uncertain outcomes by operation ID. Preserve existing download-main ownership.
- [ ] Run targeted tests, `npm run lint`, `npm test`; expect PASS. Commit Task 5 files.

### Task 6: Main import state machine and IPC

**Files:** Create `src/main/import/import-coordinator.ts`; modify `src/shared/browser-import.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`; test `tests/main/import-coordinator.test.ts`, `tests/main/ipc-security.test.ts`.

**Interfaces:** `ImportCoordinator.prepare(request): Promise<BrowserImportPreview>`, `.preview(token): BrowserImportPreview`, `.commit({token, acceptPartial, selectedExtensionIds}): Promise<BrowserImportCommitReceipt>`, `.status(): Promise<BrowserImportStatus>`, `.discard(token): Promise<void>`; it consumes Task 5's `commitImportData` and Task 2's worker client.

- [ ] Write tests for same-token double commit, concurrent prepare/profile switch, Back/discard, category failure requiring `acceptPartial`, source change after prepare, restart/retry, and receipt counts from readback state. Test that untrusted sender/path/token inputs cannot cross the existing IPC boundary.
- [ ] Run `node --test tests/main/import-coordinator.test.ts tests/main/ipc-security.test.ts`; expect new cases FAIL.
- [ ] Implement one active prepare per Vast profile, opaque expiring tokens, category-specific states and strict request validation. Register only trusted importer IPC handlers; never return canonical source paths.
- [ ] Run targeted tests, `npm run lint`, `npm test`; expect PASS. Commit Task 6 files.

### Task 7: Renderer migration to preview without early writes

**Files:** Modify `src/renderer/components/onboarding/OnboardingPage.tsx`, `src/renderer/components/onboarding/OnboardingImportStep.tsx`, `src/renderer/store/browser-store.ts`, `src/renderer/app/App.tsx`, `src/shared/types.ts`, `src/preload/index.ts`; test `tests/renderer/onboarding-store.test.ts`, `tests/renderer/onboarding-routing.test.ts`; create `scripts/browser-import-data-e2e.cjs`.

**Interfaces:** Renderer calls `window.vast.importer.prepare/preview/commit/status/discard` from Task 5. It replaces `importedKeyRef` and `mergeImportedData` with a preview token and persisted receipt. `onboarding.completion` changes only on verified commit/finish, not on navigation.

- [ ] Write tests for failed prepare then Retry, double Next/Finish, Back/Next, Fresh start, selection change, restart from committed phase, no autosave before Commit, flush `{ok:false}`, and truthful category counts. Create controlled Chrome/Edge/Firefox fixture profiles for Electron E2E; assert disk state before/after Commit and after relaunch.
- [ ] Run targeted tests/E2E; expect FAIL.
- [ ] Implement read-only preview UI, lock controls during operations, explicit partial-category consent and completion/error states; remove legacy `importer.run` IPC after migration. Keep `extensions-pending` for Plan 2 even when no extension is yet installed.
- [ ] Run targeted tests, `node scripts/browser-import-data-e2e.cjs`, `npm run lint`, `npm test`; expect PASS. Commit Task 7 files.
