# Vast 0.5.0 Direct Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release Vast 0.5.0 Direct with a working automatic upgrade from installed public 0.4.3.

**Architecture:** Merge the published 0.4.3 source into the active 0.5.0 branch, retain 0.5.0 changes, and preserve the split updater feeds. Build one sealed release candidate from a clean commit, verify it against an isolated installed 0.4.3 profile, then publish those exact bytes.

**Tech Stack:** Electron, TypeScript, Node.js, PowerShell, GitHub Releases, Cloudflare Relay.

**Spec:** `docs/LOCAL_PUBLIC_RELEASE_0.5.0.md`

## Global Constraints

- Target version `0.5.0`; previous public Direct version `0.4.3`.
- Installed 0.4.3 Direct users read `stable-v2.yml`; legacy `latest.yml` stays pinned to 0.4.2.
- Candidate is intentionally unsigned; only the sealed candidate bytes may be published.
- Install and upgrade canaries run in an isolated Windows account.

## Review Focus

- The old feed must not redirect 0.4.2 clients to the broken updater handoff.
- The new feed must select 0.5.0 for an installed 0.4.3 Direct client.
- Merge conflicts must preserve both security origin isolation and 0.4.3 fixes.
- Locked dependencies must pass audits without relying on ignored local state.
- Release notes and canary report must describe only verified behavior.

---

### Task 1: Integrate the public baseline

**Files:** `src/main/updater.ts`, `scripts/prepare-release.ps1`, `scripts/release-files.cjs`, renderer styles, package manifests and associated tests.

- [x] Commit the current verified 0.5.0 work as a recoverable checkpoint.
- [x] Merge `codex/vast-043-font-cascade` and resolve conflicts preserving 0.5.0 version and permission changes.
- [x] Run updater, styling, security and dependency tests; fix failures and commit.

### Task 2: Seal a releasable candidate

**Files:** release scripts, tests, `docs/PUBLIC_RELEASE_0.5.0.md`, ignored runner state.

- [ ] Run full release preflight and fix every failing gate.
- [ ] Review release notes and commit the final source.
- [ ] Run `npm run release:local:public -- prepare` from the clean final commit; record the sealed candidate hashes.

### Task 3: Verify and publish exact bytes

**Files:** isolated Windows test account, ignored canary report, GitHub Release assets.

- [ ] Run `verify` in the isolated account against public 0.4.3 and staged 0.5.0.
- [ ] Check actual updater feed selection, authenticated and extension canaries, and profile persistence; record evidence.
- [ ] Confirm the committed release notes remain accurate after the canaries; reseal and rerun affected gates if the source changes.
- [ ] Run `publish --canary` only when all gates pass; verify public URLs, asset hashes and actions.
