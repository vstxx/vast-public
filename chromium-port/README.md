# Vast Chromium port

This directory is the versioned Vast overlay for a standalone upstream Chromium `//chrome` build. The Chromium checkout and generated output stay outside this repository.

## Safety boundary

The scripts do not use the installed Vast directory or the normal `%APPDATA%\Vast` / `%LOCALAPPDATA%\Vast` profiles. Smoke tests create a unique temporary Chromium profile. The existing Electron build remains independent.

Do not point `VAST_CHROMIUM_SRC` at a Chromium checkout containing unrelated work. Fetch/rebase scripts refuse a dirty checkout by default.

## Default layout

```text
<chromium-root>\
  depot_tools\
  sdk-7705\
    Windows Kits\10\
  src\
    out\VastDev\
  artifacts\
    Vast-2.0.0-dev-win-x64\
```

Override paths for the current PowerShell process if needed:

```powershell
$env:VAST_CHROMIUM_SRC = '<chromium-root>\src'
$env:VAST_DEPOT_TOOLS = '<chromium-root>\depot_tools'
$env:VAST_CHROMIUM_OUT = 'out\VastDev'
$env:VAST_CHROMIUM_ARTIFACTS = '<chromium-root>\artifacts'
$env:VAST_WINDOWS_SDK_ROOT = '<chromium-root>\sdk-7705\Windows Kits\10'
```

Paths must be on NTFS and should be short and contain no spaces.

Use a fast local NTFS volume for the Chromium checkout and build output. Keep the short root outside this repository; environment overrides support any suitable location.

## Reproducible workflow

Run from the Vast repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\preflight.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\install-prerequisites.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\bootstrap-depot-tools.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\bootstrap-windows-sdk.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\fetch.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\apply-patches.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\gen.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\build.ps1 -Target chrome
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\verify-build.ps1
```

When a long build was launched with metadata under `.reports`, inspect it without touching the process:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\build-status.ps1
```

`revision.json` pins the exact upstream source, while `product.json` owns the Vast `2.0.0-dev` identity independently of Chromium's four-part engine version. `patches/series.json` is the only patch order authority. Patch application is check-first and idempotent. Generated reports are written to the ignored `.reports` directory.

Run the port tooling tests without a Chromium build:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\tests\run.ps1
```

`install-prerequisites.ps1` must be run from an elevated PowerShell and uses Microsoft-signed installers. It changes the developer toolchain only, not Vast. If Git transport to googlesource is unreliable, `bootstrap-depot-tools.ps1 -Archive` downloads the pinned official Gitiles archive; the marker records the exact depot_tools commit even though that fallback has no `.git` directory.

`bootstrap-windows-sdk.ps1` downloads the exact official SDK ISO pinned in `revision.json`, verifies its SHA-256, and uses Windows Installer administrative extraction for the x64 build and debugging tools. It does not replace the machine-wide SDK. `gen.ps1` and `build.ps1` then verify the Microsoft Authenticode signature, file version, and SHA-256 of `midl.exe` before injecting that isolated tool directory into Chromium's generated x64 environment block. `build.ps1` regenerates GN by default before this injection; use `-SkipGnGeneration` only when deliberately resuming an unchanged graph.

The first target is always `chrome`, meaning upstream `//chrome`. The project never builds `content_shell` as a product foundation.

The two smoke layers use unique profiles below `%TEMP%`. The PowerShell launch smoke verifies process identity, tabs, DevTools, top-level `accounts.google.com`, and absence of security-bypass flags. The dependency-free Node test drives Chromium only through the DevTools protocol and verifies persistent cookies after restart, service workers, popups, downloads, and the Permissions API. Node is test tooling and is not included in or required by the shipped Chromium runtime.

`verify-build.ps1` stages the development runtime below the directory configured by `VAST_CHROMIUM_ARTIFACTS` (or the script's generic local default), runs both smoke layers plus the `chrome://vast` Mojo/WebUI smoke and a Windows UI Automation check of the native Vast toolbar control against `Vast.exe`, creates JSON launch/capability/WebUI/toolbar/provenance reports plus a Phase 2 acceptance summary, and verifies the executable product name. The toolbar acceptance prepares a disposable two-workspace migration, opens the real Views radio menu, switches to a private workspace, verifies native Alpha/Beta tab groups and automatic Alpha tab assignment without a crashed page, validates the bounded journal-scoped group registry, forces a process restart, and requires named groups plus retention of every pre-restart group token. Override the root with `VAST_CHROMIUM_ARTIFACTS` or pass `-Destination`. Staging follows GN's authoritative `//chrome:chrome` runtime dependency graph and applies read/execute access for Windows AppContainer sandbox processes only within the generated package. The current component development build has thousands of DLLs, so its first cold start may take several minutes; this is not the target release package shape. Pass `-SkipGoogleNavigation` only for intentionally offline verification; the release acceptance run must use the default top-level Google navigation.

## Patch policy

Patch files use `git format-patch`/`git diff --binary` compatible syntax and paths relative to Chromium `src`. Keep high-churn upstream modifications small. Prefer adding code below `chrome/browser/vast`, `chrome/browser/ui/webui/vast`, and `chrome/common/vast` and then wiring it through narrow upstream registration points.

To test without changing the checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\check-patches.ps1
```

Public Windows SDK MIDL output can differ from Chromium's internal hermetic-toolchain baseline. Audit every x64 MIDL action reachable from `//chrome:chrome` with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File chromium-port\scripts\verify-public-midl.ps1
```

The default is read-only and reports mismatches. `-Rebaseline` is an explicit maintenance operation: it accepts only already-known `.tlb` files of unchanged length below Chromium's checked-in MIDL output tree, refuses any changed header/source output, and reruns each action after the update. Any resulting binary delta must still be captured and reviewed in the ordered Vast patch series.

## Branding and product limits

Vast uses Chromium and Vast assets only. Website Google login is tested as a normal top-level navigation. Chrome Sync, Chrome browser-level sign-in, private Google API credentials, Google Chrome assets, and UA spoofing are excluded. Widevine and proprietary codecs are not promised by this open build.
