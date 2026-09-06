# Vast documentation

This directory contains durable technical documentation for the public Vast source tree. Historical implementation worklogs, one-off release readiness reports, operator-only deployment runbooks, and superseded test reports are intentionally kept out of the public snapshot; Git history and private engineering records cover that role.

## Product and data

- [Feature status](FEATURE_STATUS.md)
- [Privacy model](PRIVACY.md)
- [Data migration and storage](DATA_MIGRATION_AND_STORAGE.md)
- [Storage recovery](STORAGE_RECOVERY.md)
- [Default-browser and protocol registration](DEFAULT_BROWSER_PROTOCOLS.md)
- [Purist layout](PURIST_LAYOUT.md)

## Security

- [Security architecture](SECURITY_ARCHITECTURE.md)
- [IPC security notes](IPC_SECURITY.md)
- [Power Tools threat model](POWER_TOOLS_THREAT_MODEL.md)
- Root [Security Policy](../SECURITY.md)

## Relay and extensions

- [Vast Relay](VAST_RELAY.md)
- [Relay client contract](VAST_RELAY_CLIENT.md)
- [Extensions documentation](extensions/)

## Release and licensing

- Root [Release guide](../RELEASE.md)
- [Release checklist](RELEASE_CHECKLIST.md)
- [Open-source license audit](OPEN_SOURCE_LICENSE_AUDIT.md)
- Root [Third-party notices](../THIRD_PARTY_NOTICES.md)

## Experimental Chromium port

The current public desktop package remains Electron-based. The Chromium port is a separate experimental engineering track.

- [Architecture](chromium-migration/architecture.md)
- [Build environment](chromium-migration/build-environment.md)
- [Feature parity](chromium-migration/feature-parity.md)
- [`chromium-port/` README](../chromium-port/README.md)
