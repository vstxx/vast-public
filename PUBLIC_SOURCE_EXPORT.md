# Vast public source export

This repository is the public, reviewable source distribution of Vast Browser. It was created as a fresh, single-root snapshot from the internal development repository so that private commit metadata, local-machine paths, generated outputs, and unrelated internal artifacts are not published.

## What is included

- Vast-owned Electron, React, TypeScript, Python, PowerShell, and C# source;
- Relay worker source, migrations, tests, and public deployment configuration;
- build, test, packaging, updater, signing, and verification tooling;
- security, privacy, release, architecture, and contribution documentation;
- third-party notices and the repository license audit.

Future release automation and update metadata target `vstxx/vast-public`.

## Intentional exclusions

- The former Cat Addon artwork archive and all generated derivatives are excluded because no redistribution license or provenance record was available. The Vast-owned feature code and asset-building tools remain present for review and for use with a properly licensed replacement.
- Generated build outputs, caches, logs, benchmark output, test artifacts, local runtime bundles, and developer-machine files are excluded.
- Existing Vast 0.1.5 binaries are not mirrored here. They bundle a GPLv3 Gyan FFmpeg build, and this repository does not yet automate publication of the complete corresponding source set for that exact binary build. Binary release workflows are fail-closed until that obligation is implemented and reviewed.

## Provenance boundary

The initial public commit is a source snapshot, not a claim that previously published binaries were built from that public commit. Those older binaries and their private-repository commit provenance must not be represented as reproducible from this snapshot. New public binaries should be built from an immutable commit in this repository and published only after every signing, verification, upgrade, and third-party-source gate passes.

See [the open-source readiness report](docs/OPEN_SOURCE_READINESS.md), [the license audit](docs/OPEN_SOURCE_LICENSE_AUDIT.md), and [the release process](RELEASE.md).
