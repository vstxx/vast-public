# Open-source license audit

Audit date: 2026-08-18

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

## FFmpeg and Gyan build

The release workflows install the Gyan **full** FFmpeg build and copy `ffmpeg.exe` and `ffprobe.exe` into the generated runtime as separate executables. Gyan states that all its current static build variants are GPLv3 and links each build to its corresponding FFmpeg source commit: <https://www.gyan.dev/ffmpeg/builds/>.

FFmpeg's own license guidance explains that optional GPL components make the resulting FFmpeg build GPL and requires corresponding source for distributed binaries: <https://ffmpeg.org/legal.html>.

Launching GPLv3 FFmpeg as a separate process does not, by itself, relicense Vast-owned source. Distribution still must:

1. include the complete GPLv3 text supplied by the Gyan package;
2. retain the exact Gyan `README.txt` with build configuration and source commit;
3. provide the complete corresponding source set for the exact distributed binaries through a GPLv3-compliant delivery method, including covered linked components and build scripts/configuration as applicable (not merely an FFmpeg repository snapshot); and
4. keep the source available for the required period and document it next to every binary download.

The runtime builder enforces items 1 and 2. **Item 3 is not yet enforced by the release workflow**, so public binary redistribution remains blocked until the complete corresponding source set is uploaded alongside each release (or another reviewed GPLv3-compliant source-delivery method is implemented) and linked from the download page.

## Experimental Chromium port

The repository stores a patch overlay, not a Chromium source checkout or staged Chromium binary. Vast-owned patch additions can be MIT-licensed, while an applied/staged Chromium distribution remains subject to Chromium's BSD-style license and its generated third-party credits. Existing tooling already requires `LICENSE.chromium.txt` in staged output.

## Excluded Cat Addon asset provenance

`third_party/cat_85_animations/README.vast.md` records that the former Cat Addon artwork archive contained no license document, author attribution, source URL, or redistribution grant. The archive, derived atlases, and packaged resource are therefore excluded from this public export.

This is not a license choice between MIT and GPL; it is an absence of permission to redistribute a third-party asset. The root MIT License cannot cure it. Before restoring artwork, VastProductions must either:

- obtain a written redistribution/modification grant compatible with public source and binary distribution, record the author/source/license, and add the required notice; or
- use properly licensed replacement material. The surrounding feature code is preserved in this export.

## Result

- Vast-owned source license: **PASS — MIT**
- Node/Electron/pdf.js compatibility: **PASS**
- Python/Playwright/PyInstaller compatibility: **PASS with notice preservation**
- FFmpeg binary obligations: **BLOCKED until corresponding source delivery is enforced**
- Cat Addon third-party asset: **EXCLUDED; Vast-owned implementation retained**
- Public source publication: **PASS**
- Public FFmpeg-containing binary publication: **BLOCKED**
