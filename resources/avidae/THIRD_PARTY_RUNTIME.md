# Video & Audio third-party runtime

Public Vast distributions bundle these independently licensed components:

- Python packages listed in `requirements.txt`, including their installed
  dependency closure. `scripts/copy-python-runtime-licenses.py` copies package
  metadata and every discovered license/notice into the generated runtime.
- Playwright's Chromium build and browser license files.
- FFmpeg and FFprobe. The release builder copies the selected binaries plus
  their accompanying `LICENSE` and `README.txt`. Vast invokes FFmpeg as a
  separate process; it is not the Vast software-update trust root.

The release operator must use a redistributable FFmpeg build and retain its
license/source instructions. The standard Vast Windows build currently uses
the Gyan FFmpeg full build, which is GPLv3. A public release must include its
GPLv3 license, exact build/configuration README, and the complete corresponding
source set for the exact binaries (including covered linked components and
build scripts/configuration as applicable) through a GPL-compliant delivery
method. That source set must be published alongside the release, or made
available through another reviewed GPLv3-compliant mechanism, and linked from
the download page. Never substitute an untracked binary: the runtime manifest pins
the exact SHA-256 of every executable and license/notice file used by Vast.

The Vast MIT license applies only to Vast-owned source. It does not replace the
licenses above. See `THIRD_PARTY_NOTICES.md` and
`docs/OPEN_SOURCE_LICENSE_AUDIT.md` before public distribution.
