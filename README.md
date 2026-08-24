# Vast

Vast is a local-first desktop browser for power users. It combines Chromium page rendering through Electron with a React application shell for workspaces, navigation, local tools, and privacy controls.

[Documentation](https://docs.vastbrowser.com) · [Website](https://vastbrowser.com)

Vast does not collect browsing telemetry. When Vast Relay is enabled, its bounded operational check-in contains only a random installation UUID, the running version, and a cumulative launch count. Relay derives first-seen and last-seen timestamps and exposes simple anonymous aggregate installation counts; it never receives URLs, searches, tabs, history, bookmarks, account identity, hardware fingerprints, or message-interaction events. See [the privacy model](docs/PRIVACY.md).

## Project status

Vast is beta software. Windows x64 is the currently tested packaging target. macOS and Linux build targets exist in the Electron configuration but are not yet release-supported or continuously verified.

The repository also contains an experimental, separately versioned Chromium-port overlay under `chromium-port/`. It is engineering work in progress, not the current public desktop package.

Vast Labs features are disabled on fresh profiles and require explicit local opt-in. Video & Audio, Network Devices, Automation, Password Manager, Advanced Diagnostics, and Spoofing are experimental. Disabling a Labs flag does not delete user data.

## Features

- Real Chromium navigation in sandboxed Electron webviews
- Vertical and horizontal tabs, groups, pinned tabs, split view, and session restore
- Locally stored workspaces, bookmarks, history, notes, reading list, downloads, and quick links
- Command palette, editable shortcuts, search-engine shortcuts, reader mode, PDF viewer, and site-data controls
- Local password vault encrypted through Electron `safeStorage`
- User-triggered local automation and LAN device discovery
- Optional self-contained Video & Audio tools using a local Flask service, Playwright Chromium, FFmpeg, and FFprobe
- Export/import, rolling backups, diagnostics, update verification, and hardened release packaging

## Install a release

Download published builds from the project's GitHub Releases page. Verify the checksum supplied with the release before running an installer. Beta artifacts may be intentionally unsigned and must be labelled as such; Windows can show an Unknown publisher or SmartScreen warning for those builds.

Release packaging, signing requirements, and artifact verification are documented in [RELEASE.md](RELEASE.md). Do not distribute a locally produced development build as an official Vast release.

## Develop locally

Prerequisites:

- Node.js compatible with the version used by CI
- npm
- Python 3 for Cat Addon asset verification and Video & Audio development
- Windows and .NET 8 when running updater integration tests or producing Windows packages

Install exactly the locked JavaScript dependencies:

```bash
npm ci
npm ci --prefix relay
python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt
```

Start the development application:

```bash
npm run dev
```

Build the application without creating an installer:

```bash
npm run build
```

Run the main validation suite:

```bash
npm run lint
npm test
npm run audit:ci
npm run release:audit
npm run test:app
```

Updater and Relay checks are available through:

```bash
npm run updater:stage
npm run test:updater
npm run check --prefix relay
```

Packaging is intentionally separate from ordinary builds. Public signed releases require externally provisioned credentials; the exceptional unsigned-beta path has its own explicit, beta-only gate. See [the release documentation](RELEASE.md) and never place keys, certificates, tokens, or passwords in the repository.

## Architecture

```text
src/
  main/        Electron lifecycle, windows, sessions, storage, IPC, downloads
  preload/     context-isolated renderer bridge
  renderer/    React application shell and browser UI
  shared/      types, constants, policy, and trust metadata
resources/
  avidae/      Video & Audio service source
  cat-addon/   Cat Addon public-source placeholder (artwork excluded)
relay/         Cloudflare Workers, migrations, control panel, and tests
scripts/       build, audit, release, updater, and test tooling
tests/         unit, contract, Electron, Relay, and updater coverage
chromium-port/ experimental upstream-Chromium overlay and migration tooling
```

Persistent product data lives below Electron `userData` and is accessed through the main-process storage boundary. Web content does not receive Node.js or the Vast preload API. More detail is available in [SECURITY.md](SECURITY.md), [the IPC notes](docs/IPC_SECURITY.md), and [the storage recovery guide](docs/STORAGE_RECOVERY.md).

## Contributing and security

Practical contribution instructions are in [CONTRIBUTING.md](CONTRIBUTING.md). Security-sensitive reports must follow [SECURITY.md](SECURITY.md); do not publish exploitable details in a normal issue before coordination.

## Licensing

Vast-owned source code is licensed under the [MIT License](LICENSE). Third-party components and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [the license audit](docs/OPEN_SOURCE_LICENSE_AUDIT.md).

This repository is the clean public-source export of Vast. The Cat Addon implementation remains available for review, while the unlicensed third-party artwork and its derived packages are intentionally excluded. See [PUBLIC_SOURCE_EXPORT.md](PUBLIC_SOURCE_EXPORT.md), [open-source readiness](docs/OPEN_SOURCE_READINESS.md), and the [license audit](docs/OPEN_SOURCE_LICENSE_AUDIT.md) before redistributing a binary build.
