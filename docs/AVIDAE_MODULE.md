# Video & Audio module

Vast Core (Electron/Chromium, extensions, adblocking, PDF, Settings, Labs and
the Video & Audio page itself) no longer ships the Video & Audio runtime. The
runtime — the PyInstaller-built local service, one full Playwright Chromium,
and the audited FFmpeg/FFprobe build — is a separately versioned, signed
module that a user downloads once, only when they choose to.

## User flow

1. Settings → Labs → Video & Audio behaves exactly as before. Enabling it
   downloads nothing.
2. Opening Video & Audio reads the local installation and, once per session,
   the small signed release manifest so the page can show the real download
   size. No archive bytes are fetched.
3. When the runtime is missing, the existing startup card shows a short
   explanation, the signed download size and **Download & Install** in place
   of the backend buttons.
4. Download → Verify → Install show progress, transferred bytes and Cancel.
   Failures show a one-line reason and **Retry**.
5. When the module is ready, the normal card returns: **Start backend**,
   "Runtime x.y.z installed" and **Stop**. The backend never starts by itself.

The manager lives in the main process, so navigating away or closing the
page does not interrupt an installation. The page receives progress pushes
(`vast:avidae:module-changed`) instead of polling.

## Components

| Path | Responsibility |
| --- | --- |
| `src/main/avidae-module.ts` | Installation state machine, cross-process lock, resumable download, verification, extraction, atomic promotion, rollback, cleanup |
| `src/main/avidae-module-manifest.ts` | Signed release manifest format and Ed25519 verification |
| `src/main/avidae-module-archive.ts` | Streaming tar + zstd extraction with inventory enforcement |
| `src/main/avidae-runtime.ts` | Pre-launch verification of an installed runtime |
| `src/main/avidae.ts` | Backend lifecycle; resolves the runtime from the module in packaged builds |
| `src/shared/avidae-module-policy.json` | Compiled-in trust policy: manifest URL, pinned keys, revocations, Store policy |
| `resources/avidae/module.json` | Module identity, version, sequence, host API and minimum Vast version |
| `scripts/prepare-avidae-runtime.cjs` | Builds the runtime and its schema 4 manifest with a complete file inventory |
| `scripts/build-avidae-module.cjs` | Packages the runtime into the module archive and the unsigned release payload |
| `scripts/sign-avidae-module.cjs` | Signs the payload; generates keys outside the repository |
| `scripts/verify-avidae-module.cjs` | Release gate: signature, digest, extraction, self-test, FFmpeg contract, licenses, size budget |
| `scripts/avidae-module-e2e.cjs` | Packaged end-to-end test against a loopback release server |
| `.github/workflows/avidae-module-release.yml` | Builds, signs and verifies a module into a private draft release |

## Release artifacts

```
VastVideoAudio-<version>-win-x64.tar.zst      module archive
ffmpeg-corresponding-source-win64.tar.zst     FFmpeg GPL corresponding source
avidae-module.json                            signed release manifest
SHA256SUMS.txt
```

The archive is a deterministic POSIX tar (ustar with pax path records) compressed
with zstd. Its first entry is `runtime-manifest.json` (schema 4): module identity
and version, host API, runtime/Python/Playwright/PyInstaller/FFmpeg versions,
FFmpeg provenance and corresponding-source references, the license inventory and
a complete inventory of every other file with size and SHA-256.

`avidae-module.json` is `{ format, keyId, signature, payload }`. The Ed25519
signature covers `"vast-avidae-module-manifest/v1\n"` followed by the canonical
JSON of `payload`, which contains: module id and version, a monotonically
increasing `sequence`, platform and architecture, host API, minimum Vast version,
the archive URL, size, SHA-256, unpacked size and file count, the digest and size
of `runtime-manifest.json`, runtime versions, the corresponding-source URL and
digest, and a list of revoked module versions.

## Verification model

- **Trust anchor.** Public keys are compiled into Vast
  (`src/shared/avidae-module-policy.json`). HTTPS and the download location
  are not trusted for authenticity. Keys carry `current`, `legacy` or
  `revoked` status; rotation adds a new key in a Vast update before the module
  pipeline signs with it.
- **Manifest.** Signature, schema, platform, host API and minimum Vast version
  are checked. URLs must be HTTPS; plain loopback HTTP is accepted only by
  development and private builds for tests.
- **Anti-replay.** `trust.json` records the highest accepted `sequence`.
  Manifests with a lower sequence are rejected, so an old signed manifest
  cannot roll an installation back. Versions revoked by Vast's policy or by a
  newer manifest become `update-required` and cannot launch.
- **Archive.** Downloaded to `.downloads/<sha256>.part` and hashed in full
  against the signed digest and size before any extraction.
- **Extraction.** Only regular files and directories are accepted; links,
  devices, absolute or traversing paths, Windows device names, alternate data
  streams, trailing dots or spaces and case-insensitive duplicates are
  rejected. `runtime-manifest.json` must come first and match its signed
  digest; every later file must be in its inventory with the recorded size and
  SHA-256, and the total output is bounded by the signed sizes. Files are
  created exclusively in a fresh staging directory.
- **Before every launch.** The executables (service, FFmpeg, FFprobe,
  Chromium) and provenance are hashed again; every other inventory file must
  exist with its recorded size. A failure marks the module `repair-required`.

The installed module is per-user and user-writable, the same trust boundary as
the per-user Direct installation of Vast itself.

## Installation layout and compatibility

| Distribution | Module root |
| --- | --- |
| Direct (installer) | `%LOCALAPPDATA%\Vast\Modules\video-audio` |
| Portable | `<portable folder>\Vast Modules\video-audio` (beside `Vast Data`) |
| Microsoft Store | `%LOCALAPPDATA%\Vast Store\Modules\video-audio` (package-virtualized); downloads are disabled by policy, see below |
| Development | `%LOCALAPPDATA%\Vast Dev\Modules\video-audio` |

```
active.json              verified pointer, written last with an atomic rename
trust.json               highest accepted sequence
<version>-<digest12>/    immutable promoted runtime
.downloads/              resumable download
.staging/                extraction workspace (never executed)
.install.lock            cross-process installation lock
```

The module is outside the roaming profile and outside profile backups.
Video & Audio jobs, settings and media remain in the profile at
`<data>\avidae`, unchanged from bundled releases.

A module is usable when its `hostApi` equals the Core's
(`AVIDAE_MODULE_HOST_API`), the Vast version is at least its
`minVastVersion`, and it is not revoked. Core updates therefore keep a
compatible module; a Core that changes the host API asks for an update.
Updates are transactional: the new version is promoted beside the old one, and
the previous verified version is retained as last-known-good until the next
successful update. A failed update leaves the current version active.

Interrupted downloads resume with a validated `Range` request (206 with the
exact `Content-Range` of the signed size); anything else restarts from zero.
An explicit cancel discards the partial download. Abandoned staging folders,
orphaned promoted folders and stale locks (dead process or older than six
hours) are cleaned at the next installation.

Microsoft Store: `microsoftStoreDownloads` is `false` until the Store
certification notes describe the module (Store Policies 10.2.2). Store builds
show Video & Audio as unavailable in that edition.

## Publication

One-time setup (done for key `vast-avidae-2026-01`):

1. `node scripts/sign-avidae-module.cjs --generate-key <folder outside the repository>`
2. Store the private PEM as the `VAST_AVIDAE_MODULE_SIGNING_KEY` secret of
   the `public-release` environment. Keep an offline backup.
3. Pin the printed public key in `src/shared/avidae-module-policy.json` with
   status `current`.
4. `manifestUrl` points at the fixed release tag `avidae-module` in
   `vstxx/vast-public`:
   `https://github.com/vstxx/vast-public/releases/download/avidae-module/avidae-module.json`.
   Ship these policy changes in a Vast release.

Each module release:

1. Bump `moduleVersion` and `sequence` in `resources/avidae/module.json`.
2. Run the **Video & Audio module release candidate** workflow with the
   version and key id. It builds the runtime with the audited FFmpeg,
   signs, verifies against the pinned keys and creates a private draft
   release `avidae-module-v<version>` in `vstxx/vast-public`.
3. Publish the draft, then upload its `avidae-module.json` to the published
   `avidae-module` release (replacing the previous one, e.g.
   `gh release upload avidae-module avidae-module.json --clobber --repo vstxx/vast-public`).
   Until that release exists, Vast reports the runtime as not available for
   download yet.

Without a configured `manifestUrl` and key, packaged Vast shows Video & Audio
as unavailable instead of downloading anything.

## Migration from bundled releases

- **NSIS installer updates** (the automatic path) remove the previous
  installation directory, including `resources\avidae-runtime`.
- **The standalone updater** copies only payload files. After a verified
  update it removes exactly `resources\avidae-runtime` and `resources\avidae`
  when the payload no longer contains them, they are plain directories
  directly under the install's `resources`, they carry the bundled marker file
  (`runtime-manifest.json` or `app.py`), and they contain no junctions or
  symbolic links. The folder is first moved atomically into the update
  transaction folder and then deleted. Repeat runs are no-ops.
- **Portable and Store** replace the whole package.
- User data, jobs and media in `<data>\avidae` are never touched. After the
  upgrade, opening Video & Audio offers the one-time download.

## Development

Source checkouts keep running the Python service directly (`npm run dev`,
"Install / repair deps"). To exercise the module installer in development or a
private build, set `VAST_AVIDAE_MODULE_MANIFEST_URL`,
`VAST_AVIDAE_MODULE_TEST_PUBLIC_KEY` and optionally `VAST_AVIDAE_MODULE_ROOT`.
Public builds ignore all three.

A local FFmpeg build that does not pass the release compliance audit can be
packaged for tests only:
`npm run avidae:runtime:prepare -- --resume --local-test`, then
`npm run avidae:module:build -- --base-url http://127.0.0.1:<port>/module --local-test`.
Such a runtime is marked and refused for any non-loopback publication.
