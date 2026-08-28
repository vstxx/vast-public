# Rebuilding Vast FFmpeg on Windows

## Requirements

- Windows x64.
- PowerShell 7 or Windows PowerShell 5.1.
- Network access to the exact HTTPS source URLs recorded in the lock file.

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-vast-ffmpeg.ps1
```

The wrapper downloads the exact MSYS2 base image and source archives, verifies
their SHA-256 values, verifies the official MSYS2 signatures on the pinned GCC,
MinGW-w64 CRT and winpthreads source packages, verifies the pinned compiler/tool
versions, builds every linked non-system dependency statically, builds
FFmpeg/FFprobe, executes the real Avidae capability suite, captures `-version`,
`-buildconf` and `-L`, and creates:

- `.vast-build/ffmpeg/runtime/bin/ffmpeg.exe`
- `.vast-build/ffmpeg/runtime/bin/ffprobe.exe`
- `.vast-build/ffmpeg/runtime/ffmpeg-build-provenance.json`
- `.vast-build/ffmpeg/avidae-ffmpeg-capabilities.json`
- `.vast-build/ffmpeg/ffmpeg-corresponding-source-win64.tar.zst`

The source archive contains exact FFmpeg and codec dependency sources, the
signed MSYS2 source packages (including their package recipes) for compiler
runtime code linked into the executables, license texts, the Vast build recipe,
sanitized configure headers/makefile and the lock file. `config.log` is
intentionally excluded because it snapshots unrelated environment variables
and can disclose CI secrets. The public release pipeline publishes this archive
beside every binary release that contains the runtime.

Verification:

```powershell
npm run ffmpeg:release:check
npm run avidae:ffmpeg:check -- --ffmpeg .vast-build/ffmpeg/runtime/bin/ffmpeg.exe --ffprobe .vast-build/ffmpeg/runtime/bin/ffprobe.exe
```

The build intentionally excludes `ffplay`, nonfree components, network TLS
libraries and unrelated third-party codecs. HTTPS uses the Windows SChannel
backend. The executables may depend only on Windows system DLLs.
