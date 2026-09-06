<div align="center">
  <img src="assets/logos/vast.png" alt="Vast Browser" width="220" />
  <h1>Vast Browser</h1>
  <p><strong>A local-first desktop browser built for deep customization and fast workflows.</strong></p>
  <p>
    <a href="https://vastbrowser.com">Website</a> ·
    <a href="https://github.com/vstxx/vast-public/releases">Releases</a> ·
    <a href="https://docs.vastbrowser.com">Documentation</a> ·
    <a href="docs/PRIVACY.md">Privacy</a> ·
    <a href="SECURITY.md">Security</a>
  </p>
</div>

Vast combines Chromium page rendering through Electron with a React application shell built around workspaces, flexible tab layouts, local tools, privacy controls, and a deliberately configurable interface.

## What Vast focuses on

- Vertical, horizontal, and experimental Purist tab layouts
- Workspaces, tab groups, pinned tabs, split view, session restore, and smart tab unloading
- Local bookmarks, history, notes, reading list, downloads, quick links, and session data
- Command palette, editable shortcuts, search-engine shortcuts, Focus Reader, PDF viewing, and site-data controls
- Chromium-compatible extensions, local `.vext` packages, the Vast Extensions Hub, and Vast Native API support
- A local password vault protected through Electron `safeStorage`
- Optional local tools for automation, LAN device discovery, diagnostics, and Video & Audio workflows
- Export/import, storage backups, update verification, and hardened Windows packaging

## Download

Windows x64 is the current release-supported target. Published installers and portable builds are available on the [Releases](https://github.com/vstxx/vast-public/releases) page.

For most users, use `Vast-Setup-<version>.exe`. The portable build is named `Vast-<version>-Portable.exe`. Other release assets are used by the updater, integrity verification, or third-party source-compliance process.

Always read the signature note attached to the specific release. Some direct Vast releases are intentionally distributed without Authenticode signing; Windows can therefore show an **Unknown publisher** or SmartScreen warning. Official releases include checksums and provenance metadata so the downloaded bytes can be verified independently.

## Privacy

Vast stores normal browser and product data locally. It does not collect browsing telemetry.

When Vast Relay is enabled for a build, its bounded operational check-in contains only a random installation UUID, the running Vast version, and a cumulative launch count. Relay derives first-seen and last-seen timestamps server-side. It does **not** receive visited URLs, searches, tabs, history, bookmarks, account identity, hardware fingerprints, extension activity, or message-interaction events.

The complete model is documented in [docs/PRIVACY.md](docs/PRIVACY.md).

## Project status

Vast is under active development. Windows x64 is the continuously exercised release target. macOS and Linux targets exist in the Electron configuration, but they are not currently release-supported or continuously verified.

Optional Labs features are off on fresh profiles and require local opt-in. Current Labs surfaces include Video & Audio, Network Devices, Automation, Password Manager, Advanced Diagnostics, and Spoofing. Turning a Labs feature off hides and blocks that feature without deleting its local data.

The repository also contains an experimental Chromium-port overlay under `chromium-port/`. It is a separate engineering track and is not the desktop package distributed from current releases.

See [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) for the maintained product-surface summary and [ROADMAP.md](ROADMAP.md) for current engineering direction.

## Develop locally

Prerequisites:

- Node.js compatible with the version used by CI
- npm
- Python 3 for Video & Audio development
- Windows and .NET 8 for updater integration tests or Windows packaging

Install locked dependencies:

```bash
npm ci
npm ci --prefix relay
python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt
```

Run the application:

```bash
npm run dev
```

Build without producing an installer:

```bash
npm run build
```

Run the normal validation baseline:

```bash
npm run lint
npm test
npm run audit:ci
npm run release:audit
npm run test:app
```

Updater and Relay work have additional checks:

```bash
npm run updater:stage
npm run test:updater
npm run check --prefix relay
```

Release packaging is intentionally separate from ordinary development builds. See [RELEASE.md](RELEASE.md) before producing or distributing release artifacts.

## Architecture

```text
src/
  main/        Electron lifecycle, windows, sessions, storage, IPC, downloads
  preload/     context-isolated renderer bridge
  renderer/    React application shell and browser UI
  shared/      types, constants, policy, and trust metadata
resources/
  avidae/      Video & Audio service source
  first-party-extensions/  first-party extension sources
extensions-hub/  extension catalog, publisher, signing, and review services
relay/         Relay Workers, migrations, control panel, and tests
scripts/       build, audit, release, updater, and test tooling
tests/         unit, contract, Electron, Relay, updater, and packaging coverage
chromium-port/ experimental upstream-Chromium overlay and migration tooling
```

Web content does not receive Node.js or the Vast preload API. Persistent product data is owned through the main-process storage boundary. See [the security architecture](docs/SECURITY_ARCHITECTURE.md), [IPC notes](docs/IPC_SECURITY.md), and [storage documentation](docs/DATA_MIGRATION_AND_STORAGE.md) for details.

## Public source model

`vstxx/vast-public` is Vast's official public source and release repository. Release source snapshots are exported from the canonical development repository and bound to the originating source commit. `.vast-source-provenance.json` records that source SHA together with intentionally excluded private, deployment-only, or operator-only material.

The public `main` branch can also contain repository-hygiene commits on top of the latest exported snapshot. Version tags remain the source anchors for their matching releases.

This model keeps release provenance explicit without publishing credentials, private operator state, internal release worklogs, or deployment-only verification material.

## Contributing

Contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md). The public documentation index is in [docs/README.md](docs/README.md).

Security-sensitive reports must follow [SECURITY.md](SECURITY.md). Do not put exploitable details, credentials, or private user data in a normal public issue.

## Licensing

Vast-owned source code is licensed under the [MIT License](LICENSE). Third-party components and assets retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/OPEN_SOURCE_LICENSE_AUDIT.md](docs/OPEN_SOURCE_LICENSE_AUDIT.md) for the maintained license and corresponding-source record.
