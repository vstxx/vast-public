# Open-source license audit

Audit date: 2026-08-24

This is a repository engineering audit, not legal advice. It records the license evidence available in the repository, installed package metadata, and upstream project notices.

## Decision for Vast-owned source

**MIT is appropriate for Vast-owned source.** The root `LICENSE` applies the MIT License with `Copyright (c) 2026 VastProductions`.

No reviewed dependency requires Vast's independently written TypeScript, React, Python, PowerShell, C#, documentation, or build scripts to be relicensed as GPL. Copyleft components remain independently licensed and carry their own obligations. The root MIT License does not cover third-party assets or code merely because they are stored in this repository.

## JavaScript and desktop runtime

`package-lock.json` contains 563 packages. Recorded license metadata is predominantly MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0, Python-2.0, CC-BY-4.0, 0BSD, and compatible multi-license expressions. The one package without a modern `license` field in the lockfile, `prelude-ls@1.1.2`, ships an MIT license and declares MIT in its legacy `licenses` metadata.

Key shipped components:

- Electron: MIT. Its binary includes Chromium and third-party code whose notices must remain available.
- Chromium: BSD-style core license plus component-specific third-party licenses and generated credits.
- `pdfjs-dist@6.2.108`: Apache-2.0.
- React, React DOM, Zustand, Electron Toolkit, and electron-updater: MIT.
- Lucide React and semver: ISC.

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

The repository stores a patch overlay, not a Chromium source checkout or staged Chromium binary. Vast-owned patch additions can be MIT-licensed, while an applied/staged Chromium distribution remains subject to Chromium's BSD-style license and its generated third-party credits. Existing tooling already requires `LICENSE.chromium.txt` in staged output.

## Release-blocking asset provenance

`third_party/cat_85_animations/README.vast.md` records that `assets/cat-addon/Cat_85_Animations.zip` contains no license document, author attribution, source URL, or redistribution grant. Derived atlases and `resources/cat-addon/cat_addon.zip` inherit that unresolved provenance.

This is not a license choice between MIT and GPL; it is an absence of permission to redistribute a third-party asset. The root MIT License cannot cure it. Before publication, VastProductions must either:

- obtain a written redistribution/modification grant compatible with public source and binary distribution, record the author/source/license, and add the required notice; or
- replace/remove the asset and all derived copies with properly licensed material while preserving the surrounding feature code as appropriate.

## Result

- Vast-owned source license: **PASS — MIT**
- Node/Electron/pdf.js compatibility: **PASS**
- Python/Playwright/PyInstaller compatibility: **PASS with notice preservation**
- FFmpeg binary obligations: **PASS — self-built GPLv3 runtime, complete corresponding source and hard release gates**
- Cat Addon third-party asset: **BLOCKED pending provenance/license**
- Overall third-party publication readiness: **PASS for the public configuration with `VAST_CAT_ADDON_ENABLED=0`; Cat Addon remains blocked if enabled**
