# Open-source license audit

Audit date: 2026-09-19

This is a repository engineering audit, not legal advice. It records the license evidence available in the repository, installed package metadata, and upstream project notices.

## Decision for Vast-owned source

**Vast-owned source is licensed under GPL-3.0-only.** The root `LICENSE` contains the canonical GNU General Public License version 3 text. The project intentionally selected the version-3-only SPDX form so the desktop application can distribute `electron-chrome-extensions` through its GPL-3.0 path.

This project-level relicensing does not claim ownership of third-party assets or code. Electron, Chromium, permissive dependencies, MPL files, GPL filter assets, FFmpeg, fonts, and other vendored/generated inputs retain their upstream licenses and notices. Their inclusion in a GPL-covered combined distribution does not change their upstream license grants.

Git history contains commits under the `vstxx`/`vstxx0` identities and one local Codex checkpoint made for the same repository owner. No separate external contributor identity was found. Existing third-party material is recorded by provenance rather than treated as Vast-owned. No CLA or copyright assignment system is required by the reviewed history; future contributions are accepted for inclusion under GPL-3.0-only as stated in `CONTRIBUTING.md`.

## JavaScript and desktop runtime

`package-lock.json` contains 563 packages. Recorded license metadata is predominantly MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, Python-2.0, CC-BY-4.0, 0BSD, and compatible multi-license expressions. The one package without a modern `license` field in the lockfile, `prelude-ls@1.1.2`, ships an MIT license and declares MIT in its legacy `licenses` metadata.

Key shipped components:

- Electron: MIT. Its binary includes Chromium and third-party code whose notices must remain available.
- Chromium: BSD-style core license plus component-specific third-party licenses and generated credits.
- `electron-chrome-extensions@4.9.0`: Vast uses the upstream GPL-3.0 option. The exact GPL text and modification/source record must ship with public binaries and corresponding source.
- `pdfjs-dist@6.2.108`: Apache-2.0.
- React, React DOM, Zustand, Electron Toolkit, and electron-updater: MIT.
- Lucide React and semver: ISC.
- `tldts@7.4.11` and `tldts-core@7.4.11`: MIT; used for complete PSL/eTLD+1 classification.

Primary upstream references:

- Electron license: <https://github.com/electron/electron/blob/main/LICENSE>
- Chromium license: <https://chromium.googlesource.com/chromium/src/+/HEAD/LICENSE>
- PDF.js license: <https://github.com/mozilla/pdf.js/blob/master/LICENSE>

## Video & Audio / Avidae runtime

Direct Python dependencies are pinned in `resources/avidae/requirements.txt`; PyInstaller is pinned separately as build tooling. Installed distribution metadata and dependency closure were inspected.

- Flask/Werkzeug/Jinja family: BSD-style licenses.
- Flask-SocketIO, python-socketio, python-engineio, simple-websocket, wsproto, h11, pyee, greenlet, and related runtime packages: permissive MIT/BSD-style licenses.
- Playwright for Python: Apache-2.0, with NOTICE and third-party notices.
- Playwright Chromium/headless shell: Chromium BSD-style and bundled third-party terms. `LICENSE.headless_shell` must ship.
- Pillow: MIT-CMU.
- python-dotenv: BSD-3-Clause.
- yt-dlp: Unlicense.
- `bidict`: MPL-2.0. MPL obligations are file-scoped; distributing a modified MPL-covered file requires making that covered source available under MPL. It does not relicense unrelated Vast files.
- PyInstaller: GPL-2.0-or-later with the project's bootloader exception. PyInstaller states that generated executable bundles may use the application's license, subject to bundled dependency licenses: <https://pyinstaller.org/en/stable/license.html>.

`scripts/copy-python-runtime-licenses.py` now inventories the installed dependency closure and copies every discovered license/notice into the generated runtime. `scripts/prepare-avidae-runtime.cjs` hashes that inventory and fails if the required FFmpeg, Playwright, Chromium, or Python notice set is absent.

## Vast self-built FFmpeg

Vast no longer downloads or redistributes a Gyan binary. The audited Windows
runtime is FFmpeg **9.0.1**, built by Vast from the exact source and toolchain
inputs in `third_party/ffmpeg/ffmpeg-build.lock.json`. Avidae directly depends
on libx264 preset, CRF and low-latency semantics for recording, compression,
conversion, trim and merge. Removing x264 or silently substituting a Windows
encoder would regress that contract, so the reviewed build intentionally uses
`--enable-gpl --enable-version3` and is distributed under GPLv3-or-later.

All linked non-system codec dependencies are statically built from pinned
sources: x264, libvpx, Opus, libogg, libvorbis and LAME. The exact official
MSYS2 source packages and detached signatures for GCC/GCC runtime libraries,
MinGW-w64 CRT and winpthreads are pinned and preserved as well. The release
provenance records the exact FFmpeg commit/version mapping, source URLs and
SHA-256 values, configuration, compiler/tool versions, PE imports, binary
hashes, license mode, capability-report hash and source-archive hash. `ffmpeg
-version`, `-buildconf` and `-L` output is captured rather than inferred from
an artifact name.

Every build produces `ffmpeg-corresponding-source-win64.tar.zst`. It contains
the exact FFmpeg and dependency source trees, signed compiler-runtime source
packages with their MSYS2 package recipes, license texts, the PowerShell and
shell build recipes, source/toolchain lock, capability and compliance tooling,
build instructions, and sanitized configure headers/makefile. The complete
`config.log` is deliberately excluded because FFmpeg snapshots unrelated
environment variables there, including values that can be CI secrets.
`scripts/check-ffmpeg-release-compliance.cjs` fails closed if provenance,
inner or outer source hashes, GPL texts, source
identities, configuration, source contents, system-only PE imports or executable
capability tests do not match. The same gate runs before Avidae staging, before packaging,
against the actual packaged runtime, and against downloaded release assets.
Public workflows upload the source archive and provenance beside every binary
release and include both in release checksums.

Launching the GPLv3 executables as separate processes does not, by itself,
relicense Vast-owned source. The GPLv3 texts and complete corresponding source
delivery remain mandatory and are now mechanically enforced. FFmpeg's upstream
license guidance is available at <https://ffmpeg.org/legal.html>.

## Experimental Chromium port

The repository stores a patch overlay, not a Chromium source checkout or staged Chromium binary. Vast-owned patch additions are GPL-3.0-only, while an applied/staged Chromium distribution remains subject to Chromium's BSD-style license and its generated third-party credits. Existing tooling requires `LICENSE.chromium.txt` in staged output.

## Release-blocking asset provenance

The previously bundled unlicensed pixel-art asset (Cat Addon) has been removed from the repository, resolving that provenance blocker.

## Result

- Vast-owned source license: **PASS — GPL-3.0-only**
- Node/Electron/pdf.js compatibility: **PASS**
- Python/Playwright/PyInstaller compatibility: **PASS with notice preservation**
- FFmpeg binary obligations: **PASS — self-built GPLv3 runtime, complete corresponding source and hard release gates**
- ECE GPL source/notice packaging: **PASS only when the maintained release compliance gate and corresponding-source snapshot pass**
- Overall third-party publication readiness: **CONDITIONAL PASS — every public binary must have a matching public source tag and license bundle**
