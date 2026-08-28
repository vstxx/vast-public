# Avidae media capability contract

This matrix is derived from every FFmpeg/FFprobe invocation in `resources/avidae`
and from `scripts/avidae-ffmpeg-capabilities.cjs`. The executable capability suite
is authoritative; this document explains the licensing decision.

| Capability | Required | Implementation | License component | LGPL alternative | Regression risk |
| --- | --- | --- | --- | --- | --- |
| Probe streams, formats and metadata | Yes | `ffprobe` | FFmpeg | Native LGPL FFmpeg | Low |
| Decode H.264, HEVC, VP8/VP9, AV1 and supported audio | Yes | FFmpeg native decoders plus libvpx/libopus/libvorbis | LGPL/BSD components | Same | Low |
| H.264 MP4 recording and transcoding | Yes | `libx264`, including preset, CRF and `zerolatency` controls | x264 GPL-2.0-or-later; resulting FFmpeg GPLv3 | Windows encoders do not preserve the current command contract across supported systems | High |
| AAC/MP3/Vorbis/Opus/FLAC/PCM audio output | Yes | native AAC/FLAC/PCM plus LAME, Vorbis and Opus | LGPL/BSD-compatible dependencies | Same | Low |
| VP9/Opus WebM output | Yes | libvpx/libopus | BSD | Same | Low |
| MP4/WebM/MKV/AVI remux and transcode | Yes | FFmpeg muxers/demuxers | FFmpeg GPLv3 build | Same except H.264 encoder | High if x264 is removed |
| Trim, seek and concatenation | Yes | stream copy, concat demuxer and concat filter | FFmpeg GPLv3 build | Native LGPL FFmpeg | Low |
| Thumbnails and frame extraction | Yes | MJPEG encoder and scale filter | FFmpeg GPLv3 build | Native LGPL FFmpeg | Low |
| Crop, FPS, overlay, scale, pad, audio resample and fades | Yes | native filters | FFmpeg GPLv3 build | Native LGPL FFmpeg | Low |
| Page recording | Yes | raw BGRA pipe to x264 MP4 | x264 GPL | No drop-in parity for current flags | High |
| Windows screen/microphone capture | Yes | `gdigrab` and `dshow` devices | FFmpeg GPLv3 build | Native LGPL FFmpeg | Low |
| HTTP/HTTPS media inputs | Yes | FFmpeg networking with Windows SChannel | FFmpeg GPLv3 build | Native LGPL FFmpeg | Low |

An LGPL-only build was rejected because removing `libx264` would change existing
public encoding behavior and availability. Vast therefore builds the separate
FFmpeg executables in GPLv3 mode and distributes the complete corresponding
source for that exact build alongside every binary release.
