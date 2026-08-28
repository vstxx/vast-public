# Video & Audio third-party runtime

Public Vast distributions bundle independently licensed components:

- Python packages listed in `requirements.txt`, including their installed
  dependency closure. `scripts/copy-python-runtime-licenses.py` records package
  metadata and copies discovered license and notice files.
- Playwright's Chromium build and its browser license inventory.
- Vast's self-built FFmpeg 9.0.1 and FFprobe executables. This build is GPLv3
  because Avidae depends on x264 H.264 encoding behavior. FFmpeg is invoked as
  a separate process and is not covered by Vast's MIT license.

The FFmpeg runtime is built only from the exact, SHA-256-pinned sources and
MSYS2 toolchain inputs in `third_party/ffmpeg/ffmpeg-build.lock.json`. The
runtime includes the GPLv3 and linked-library license texts plus a manifest
that binds the exact executable hashes to build configuration and provenance.

Every Vast release containing these executables must publish
`ffmpeg-corresponding-source-win64.tar.zst` beside the binary assets. That
archive contains exact FFmpeg, x264, libvpx, Opus, libogg, libvorbis and LAME
source trees; official signed MSYS2 source packages and package recipes for the
GCC, MinGW-w64 CRT and winpthreads runtime code; build scripts, configuration
headers/makefile, instructions and license texts sufficient to rebuild the covered
components. Release gates verify the inner and outer source hashes, provenance,
binary hashes, license mode, system-only DLL imports and the real Avidae
capability suite. An arbitrary PATH or prebuilt FFmpeg binary cannot enter
public packaging.

The Vast MIT license applies only to Vast-owned source. See
`THIRD_PARTY_NOTICES.md`, `third_party/ffmpeg/README.md` and
`docs/OPEN_SOURCE_LICENSE_AUDIT.md` before public distribution.
