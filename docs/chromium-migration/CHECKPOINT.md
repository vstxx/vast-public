# Chromium migration checkpoint

Checkpoint date: 2026-07-17 (Europe/Warsaw)

## Freeze decision

Active Chromium development is frozen after this checkpoint. The checkout, patch series, local build outputs, SDK overlay, reports, and staged artifacts are intentionally preserved so the work can be resumed later. The Electron 1.0.11 Google-auth sprint is now the only active product work.

No production Vast installation or user profile was used by the Chromium tests. Development used disposable profiles. The installed Vast directory and `%APPDATA%\Vast` were not modified by the port.

## Repository state

- Main repository branch at checkpoint: `master`.
- Main repository HEAD: `5a47c632fa78cd21fe1b85af2d57b9ce72997577`.
- Git reported repository ownership from a previous Windows SID. Audit commands therefore used a process-local `safe.directory=<repo>` override; no global Git setting was changed.
- The main worktree contains pre-existing/mixed Electron changes outside the Chromium scope. They were not reset, cleaned, staged, or included with this checkpoint.
- Chromium-owned source scope is limited to `chromium-port/` and `docs/chromium-migration/`.
- Generated reports and local artifacts under `chromium-port/.reports/`, `chromium-port/.generated/`, and `chromium-port/.artifacts/` remain on disk and are intentionally excluded from the source checkpoint.

## Pinned source and build environment

- Chromium version: `150.0.7871.125`.
- Chromium commit: `0e1f2fbe541be34886118f3d54cf53f7e12bf905`.
- depot_tools commit: `9073d17d5650ede601bc1f59c822973d2c25b86a`.
- Chromium checkout: `<chromium-root>\src`.
- Build output: `<chromium-root>\src\out\VastDev`.
- Preserved patch-baseline worktree: `<chromium-root>\vast-baseline23-patch`.
- Isolated public SDK overlay: `<chromium-root>\sdk-7705`.
- Pinned SDK servicing version: `10.0.26100.7705`.

The last generated GN configuration is present in `out\VastDev\args.gn`:

```gn
is_debug = false
is_component_build = true
target_cpu = "x64"
is_chrome_branded = false
is_vast_branded = true
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
use_remoteexec = false
```

`out\VastDev\build.ninja` was last generated on 2026-07-16 23:24 local time. No `gn gen`, build, fetch, `gclient`, Ninja, or other Chromium process was active when the checkpoint was finalized.

## Patch and build state

The source series contains 23 patches. `0001` through `0022` form the last formally staged shell22 build. `0023-vast-workspace-last-active-tab.patch` is a later source candidate that persists a URL-free, workspace-relative active-tab index, reconciles Chromium-remapped group tokens after native session restoration, and requests a crash-safe native session snapshot.

Evidence for candidate 0023:

- all `0001` through `0022` patches applied successfully to the clean pinned baseline worktree;
- 0023 independently passes `git apply --check --cached` against that staged shell22 baseline and reverse-checks against the current Chromium candidate tree;
- the incremental `chrome` target built successfully after the candidate changes;
- `vast_data_unittests.exe`: 35/35 passed;
- three consecutive fresh disposable-profile toolbar/restart smoke tests passed, including Chromium group-token remapping and restoration of the exact selected Beta tab;
- latest source smoke report: `chromium-port/.reports/vast-toolbar-smoke-20260716-235857.json`.

The aggregate `check-patches.ps1` validation was attempted again at freeze time but exceeded the 240-second command limit without producing a result. It left no child process. Consequently 0023 is recorded as a tested candidate, not as a formally staged shell23 acceptance artifact.

The last formally staged and accepted package remains:

`<chromium-root>\artifacts\Vast-2.0.0-dev-win-x64-shell22-final\Vast.exe`

- SHA-256: `a4e6e7b9d9a0d7072a25e53ba9eaaa8372146a7f92322f6e1ff27986f572a732`.
- Phase 2 acceptance: passed.
- Electron-named runtime audit: absent.
- Security-bypass GN argument audit: passed.
- Acceptance report: `chromium-port/.reports/phase2-acceptance-20260716-185834.json`.

There is no formally staged shell23 package.

## MIDL and SDK note

The machine-wide Windows 11 SDK exposed a newer `midl.exe` behavior than the Chromium baseline. Even the exact public Microsoft SDK 10.0.26100.7705 generated two x64 TLB files with a ten-byte difference while all sibling outputs remained byte-identical. Chromium's documented MIDL rebaseline path was used narrowly for:

- `elevated_tracing_service`;
- updater `legacy_idl`.

Those two deterministic baselines are patch `0002-rebaseline-public-sdk-midl.patch`. Validation remains enabled. The isolated SDK overlay, Microsoft signature/version checks, pinned SHA-256 values, and reproducible bootstrap commands are documented in `build-environment.md` and `revision.json`. Do not replace this with a global SDK mutation when resuming.

## Preserved local state

Do not delete these paths when resuming:

- `<chromium-root>\src`;
- `<chromium-root>\src\out\VastDev`;
- `<chromium-root>\artifacts`;
- `<chromium-root>\sdk-7705`;
- `<chromium-root>\vast-baseline23-patch`;
- repository `chromium-port/` and `docs/chromium-migration/`;
- ignored `.reports`, `.generated`, and `.artifacts` directories under `chromium-port/`.

The Chromium source checkout is deliberately dirty because the patch series is applied directly to the pinned detached HEAD. `siso_result.json` is a generated local build file. Do not confuse either condition with user Electron changes in the main repository.

## Safe resume sequence

From the Vast repository, after consciously ending the Electron-auth sprint:

```powershell
& .\chromium-port\scripts\preflight.ps1
& .\chromium-port\scripts\check-patches.ps1
& .\chromium-port\scripts\gen.ps1
& .\chromium-port\scripts\build.ps1 -Target chrome
& "$env:VAST_CHROMIUM_SRC\out\VastDev\vast_data_unittests.exe" --gtest_color=no
& .\chromium-port\scripts\vast-toolbar-smoke-test.ps1 -WorkspaceMenuFixture
```

Before promoting 0023, require a completed aggregate patch-series check and a new staged shell23 acceptance run. Do not infer that shell22 acceptance covers 0023.

## Remaining product status

The native build is a real Chromium browser and contains the early Vast shell, WebUI, migration/backup path, palette, workspace toolbar, selection, and native workspace tab groups. It is not a full replica of Electron Vast: most feature parity, editable product data, side panels, vault, updater/installer, Video & Audio, macros, local Labs controls, and broad UI parity remain unfinished.

This checkpoint does not authorize further Chromium work during the Electron Google-auth sprint.
