# CWS Native Crash Fix Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Keep the CWS production guard active until the binary acceptance gate passes.

**Goal:** Move Vast's patched Windows Electron runtime from 44.3.0 to 44.7.0 and allow ordinary Chrome Web Store browsing only after native crash and regression verification.

**Architecture:** Rebase the seven native patches onto the official Electron 44.7.0/Chromium 152.0.7977.130 sources, build a symbolized Windows x64 binary, and record its exact provenance. A main-process runtime capability derived from the approved binary fingerprint authorizes CWS navigation; all unverified runtimes retain the current fallback.

**Tech Stack:** Electron/Chromium C++, GN/Ninja, Node.js, TypeScript, Windows Crashpad.

**Spec:** User's attached native crash fix request and `docs/superpowers/specs/2026-10-08-cws-bridge-design.md` on draft PR #11. This phase excludes extension installation.

## Global Constraints

- Keep `master`, existing user profiles, and the previous source and build outputs recoverable.
- Retain all seven patch behaviors, ECE 4.9.0, security settings, and the unverified-runtime CWS block.
- Generate commits, hashes, binary sizes, and versions from actual source and output.
- Do not publish, merge, or implement Chrome Web Store installation.

## Review Focus

- A redirect into CWS must receive the same decision as a direct URL.
- A restored CWS tab must remain blocked on an unverified runtime.
- A renderer must not grant itself CWS capability.
- A consent page or canceled load must never count as a successful CWS load.
- The seven patch functions and CSS fixes must survive the rebase.

---

### Task 1: Preserve and rebase native sources

**Files:** `experiments/electron-44-patches/0004` through `0010`, `experiments/electron-44-patches/README.md`.

- [ ] Record old source commits, dirty diffs, GN arguments, binary and symbol identities; preserve recoverable backups.
- [ ] Check out Electron v44.7.0 and sync its exact Chromium dependency without weakening host security.
- [ ] For each of seven patches, compare to upstream, apply or revise explicitly, and verify the final source diff.
- [ ] Confirm upstream commit `39806bed06fc8e397e86329f14fcbbb1089a9946` is an ancestor and its API suppression is in source.
- [ ] Commit the patch queue and rebase rationale.

### Task 2: Build and prove native runtime

**Files:** `patches/extension-compatibility-runtime.json`, runtime verification and release preparation scripts, `package.json`, `package-lock.json`.

- [ ] Build the patched runtime with symbols using appropriate GN/Ninja settings and preserved artifacts.
- [ ] Measure the binary, source, patchset, and ECE fingerprints; update pins and strict verification without guessed values.
- [ ] Run `test:electron-version`, runtime check, CSS gate, and native compatibility gate against that binary.
- [ ] Commit only after exact binary provenance and gates are recorded.

### Task 3: Investigate both native CWS crash signatures

**Files:** `experiments/extension-compatibility-spike/` and a dedicated CWS acceptance runner.

- [ ] Create a failing acceptance check for actual CWS page commitment, process survival, dump collection, and 60-second stability.
- [ ] Run clean zero-extension cases for Crash B, then extension/ECE and persistent-session cases for Crash A; retain failures and symbolize dumps.
- [ ] If Crash A reproduces, add a targeted native regression and the smallest source fix before repeating acceptance.
- [ ] Commit the reproducible harness and verified findings.

### Task 4: Gate CWS navigation by verified runtime

**Files:** `src/shared/top-level-navigation-policy.ts`, `src/main/sessions.ts`, renderer routing, preload/main capability plumbing, and navigation/startup tests.

- [ ] Write failing tests for direct, redirected, new-window, forwarded, and restored CWS navigation on verified and unverified runtimes.
- [ ] Implement main-authoritative runtime capability based on the approved binary and propagate only the decision needed by renderer routing.
- [ ] Run focused tests, `npm test`, `npm run lint`, and startup recovery tests.
- [ ] Keep the guard enabled if native acceptance is incomplete.

### Task 5: Full regression and factual report

**Files:** `audit/cws-native-crash-fix-2026-10-08.md`.

- [ ] Run the extension, adblock, browser, CSS, performance, and security regressions with isolated profiles.
- [ ] Report every pass, failure, and blocked test with the executable hash, final URL, dump and symbol evidence, and release readiness.
- [ ] Review the branch diff, commit the report, and leave the branch unmerged.
