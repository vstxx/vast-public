# Chromium build environment

Captured on 2026-07-15. This is a factual snapshot, not a claim that a Chromium build has passed.

## Official requirements used

The source of truth is Chromium's current [Windows build instructions](https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/windows_build_instructions.md). At audit time they require Windows 10 or later, an x86-64 host, at least 100 GB on NTFS, Visual Studio 2026 with Desktop development with C++ and ATL/MFC, Windows 11 SDK `10.0.26100.7705`, and Debugging Tools `10.0.26100.3323` or newer. They prescribe `depot_tools`, `fetch chromium --no-history`, GN, and `autoninja -C <out> chrome`.

## Sanitized capability snapshot

| Item | Detected | State |
| --- | --- | --- |
| OS | Windows 11 x64 | pass |
| CPU | x64 multicore host | pass |
| RAM | sufficient for bounded local parallelism | pass, build parallelism may need limiting |
| Source volume | fast local NTFS volume with sufficient free space | pass |
| Repository volume | separate from the Chromium checkout | informational |
| Long path policy | disabled | warning; use short paths |
| Git | 2.55 | pass |
| Python | 3.13.14 system install | informational; depot_tools Python must lead PATH |
| Node/npm | Node 24.18 | Electron/UI tooling only |
| Visual Studio | Community 2026 18.8.0 | pass after user-authorized install |
| Desktop C++ workload | registered in the VS 2026 instance | pass |
| ATL/MFC | registered in the VS 2026 instance | pass |
| Windows SDK | machine-wide `10.0.26100.0` layout reports 8249; isolated signed 7705 tools under `<chromium-root>\sdk-7705` | pass through pinned isolated build input |
| SDK Debugging Tools | isolated signed 10.0.26100.7705 x64 payload under `<chromium-root>\sdk-7705` | pass |
| depot_tools/gclient/GN/Ninja | pinned `depot_tools` under `<chromium-root>\depot_tools` | pass |

## Directory contract

The default paths are intentionally outside this Git repository and contain no spaces:

```text
VAST_CHROMIUM_SRC=<chromium-root>\src
VAST_DEPOT_TOOLS=<chromium-root>\depot_tools
VAST_CHROMIUM_OUT=out\VastDev
VAST_CHROMIUM_ARTIFACTS=<chromium-root>\artifacts
```

Scripts set a process-local PATH with `depot_tools` first and set `DEPOT_TOOLS_WIN_TOOLCHAIN=0`. They do not permanently edit the user's PATH. The first `gclient` initialization is invoked through `cmd.exe`, matching the official Windows instructions.

Chromium's recommended Git settings are written to `<chromium-root>\.vast-gitconfig` and exposed only through the child process `GIT_CONFIG_GLOBAL`. The user's global Git configuration and unrelated repositories are not modified.

## Pinned source

ChromiumDash reported Windows stable `150.0.7871.125`; the corresponding upstream commit is `0e1f2fbe541be34886118f3d54cf53f7e12bf905` at branch position `1639810`. The pin is stored in `chromium-port/revision.json`; scripts use the commit, not a floating branch.

## Build profiles

`VastDev` is a local x64 development build optimized for iteration: Vast product identity layered on open Chromium behavior, no official Google branding, no remote execution, no proprietary API credentials, and reduced symbols. Security features are not disabled. A packaging profile will be added separately; a development build must not be published as stable.

Expected first target:

```powershell
chromium-port\scripts\gen.ps1
chromium-port\scripts\build.ps1 -Target chrome
```

The acceptance build target remains upstream `//chrome`; `content_shell` is never used.

`build.ps1` defaults to eight Ninja jobs to bound memory pressure on a typical development host. Pass `-Jobs 0` only when deliberately allowing Ninja to choose its own parallelism.

Development staging defaults to `<chromium-root>\artifacts`, outside this repository. The component build currently has roughly four thousand runtime dependencies; a completely cold first launch can exceed two minutes while Windows maps those DLLs. The acceptance harness allows 300 seconds for that first launch. A later non-component packaging build must remove this development-only startup and distribution overhead.

After the prerequisite installation, `gn gen out\VastDev` completed in 52 seconds and generated 30,791 targets from 4,771 files. The first `//chrome:chrome` build uses local Siso/Ninja in offline mode; build success is recorded separately only after the executable exists.

The initial compile completed 6,756 actions before Chromium's MIDL reproducibility check found a ten-byte difference in one generated `tracing_service_idl.tlb`. The source IDL and build rule are unmodified by Vast, and every other file from that action was byte-identical. The local `midl.exe` is signed Microsoft SDK build `10.0.26100.8249`; the pinned Chromium instructions require SDK build `10.0.26100.7705`. The exact 7705 SDK is therefore treated as a versioned build input rather than rebaselining Chromium against a newer local tool.

The exact public 10.0.26100.7705 payload is extracted from Microsoft's official archived ISO into `<chromium-root>\sdk-7705` without changing the global SDK. The ISO SHA-256 and x64 `midl.exe` SHA-256 are pinned in `revision.json`; the tooling also requires a valid Microsoft Authenticode signature and the exact file version. The supported public MIDL generated all text outputs byte-identically and the same ten-byte TLB delta as 8249, showing that the checked-in TLB came from an older MIDL behavior. Chromium's documented `midl.py` rebaseline path was used for that one file, retained as an explicit patch, and the formerly failing action passed afterward.

The same isolated extraction contains the SDK 7705 x64 debugging payload. `cdb.exe` is Microsoft-signed, version-checked, and pinned by SHA-256, so preflight no longer depends on copying or globally installing an unrelated debugger binary.
