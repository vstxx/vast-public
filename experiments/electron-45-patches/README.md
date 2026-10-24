# Electron 45.0.0 compatibility patch queue (rebased, unbuilt)

Base: Electron `v45.0.0`, Chromium `156.0.8078.48`. Rebased from `../electron-44-patches/` (the `electron-44.7.0-vast-r1` queue). Not loaded by Vast, and no binary has been built from it yet.

Apply in order: `0004`, `0006`, `0007`, `0008` to `src/electron`; `0005`, `0010` to `src`. `0009` is dropped because Chromium 156 already contains the upstream fix it backported.

Each file applies with `git apply --check` (no fuzz) to the upstream sources and makes the same added/removed lines as its 44 original. See `docs/ELECTRON_45_READINESS.md` for the hand-resolved conflicts, the upstream changes that still need a compile and behavior check, and the gates required before the runtime manifest may point at an Electron 45 binary.
