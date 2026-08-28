# Third-party notices

The root MIT License covers source owned by VastProductions. It does not replace or override third-party licenses. Release builders must preserve the license and notice files supplied with every bundled component.

## Desktop JavaScript runtime

The locked npm dependency tree contains permissive licenses including MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, Python-2.0, CC-BY-4.0, 0BSD, and compatible multi-license choices. Important shipped components include:

| Component | License | Distribution requirement |
| --- | --- | --- |
| Electron | MIT, plus Chromium and bundled third-party notices | Retain Electron's license and Chromium's generated third-party credits in binary distributions. |
| Chromium within Electron | BSD-style plus many component-specific licenses | Retain the Chromium license and bundled credits/notices. |
| `pdfjs-dist` | Apache-2.0 | Retain its license and applicable notices. |
| React / React DOM / Zustand / Electron Toolkit / electron-updater | MIT | Retain copyright and license notices. |
| Lucide React / semver | ISC | Retain copyright and license notices. |
| `fflate` | MIT | Retain its copyright and MIT license notice; used for bounded ZIP deflate/inflate after Vast's own strict ZIP validation. |

The authoritative versions are pinned in `package-lock.json`. `node_modules` is not committed.

## Video & Audio runtime

Public Windows packages can bundle a generated Python/Playwright/media runtime. `scripts/prepare-avidae-runtime.cjs` inventories and hashes the license files copied into that runtime.

| Component | License or status | Notes |
| --- | --- | --- |
| Flask and Werkzeug family | BSD-3-Clause | License files are copied from installed distributions. |
| Flask-SocketIO, python-socketio, python-engineio, simple-websocket, wsproto, h11, pyee, greenlet | MIT or equivalent permissive terms | Exact metadata and notices are copied at build time. |
| Playwright for Python | Apache-2.0 | Preserve its LICENSE, NOTICE, and ThirdPartyNotices files. |
| Playwright Chromium / headless shell | Chromium BSD-style plus bundled third-party terms | Preserve `LICENSE.headless_shell` and browser notices. |
| Pillow | MIT-CMU | Preserve its license. |
| python-dotenv | BSD-3-Clause | Preserve its license. |
| yt-dlp | Unlicense | Preserve the supplied license file. |
| bidict | MPL-2.0 | Preserve its file-level MPL notice and make modified MPL-covered files available when required. It does not relicense unrelated Vast source. |
| PyInstaller | GPL-2.0-or-later with the PyInstaller bootloader exception | Used as build tooling. The exception permits generated executables to use the application's license, subject to licenses of bundled dependencies. |
| Vast self-built FFmpeg 9.0.1 (`ffmpeg.exe`, `ffprobe.exe`) with x264, libvpx, Opus, libogg, libvorbis and LAME | GPLv3 overall; component and compiler-runtime licenses are inventoried with the runtime | These are separate executables. Public distributions include license texts and publish the hash-bound complete corresponding-source archive, including signed sources/package recipes for linked compiler runtime code, beside the binary assets. |

FFmpeg's GPL terms apply to the self-built FFmpeg executables; they do not change the license of Vast-owned source merely because Vast launches those executables as separate processes. This distinction does not remove FFmpeg redistribution obligations. Exact build and source provenance is in `third_party/ffmpeg/ffmpeg-build.lock.json` and the release's `ffmpeg-build-provenance.json`.

## Chromium-port overlay

`chromium-port/` contains Vast-authored patches and tooling for an experimental open Chromium build. Applying those patches creates a combined Chromium source/build tree governed by Chromium's BSD-style license and the many third-party licenses recorded by Chromium, in addition to the MIT terms for Vast-owned additions. A staged Chromium package must include `LICENSE.chromium.txt` and Chromium's generated credits.

## Cat Addon asset blocker

`assets/cat-addon/Cat_85_Animations.zip` and derived Cat Addon pixel assets currently have no recorded author, source URL, license, or redistribution grant. The repository must not be made public, and those assets must not be distributed, until VastProductions obtains and records a compatible grant or replaces/removes them with assets whose provenance permits publication. The root MIT License does not cover or cure this missing grant.

See [docs/OPEN_SOURCE_LICENSE_AUDIT.md](docs/OPEN_SOURCE_LICENSE_AUDIT.md) for the decision record and current blockers.
