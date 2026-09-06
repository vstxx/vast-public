# Security Policy

Security reports are treated separately from normal bug reports. Please avoid publishing exploit details, credentials, private user data, or a proof of concept that would make an uncoordinated attack practical.

## Supported versions

Security fixes target the latest published Vast release and the current default branch. Older prereleases should be treated as unsupported once a newer release is available unless a release notice explicitly says otherwise.

## Reporting a vulnerability

Use GitHub's **Security** tab and **Report a vulnerability** when private vulnerability reporting is available for this repository.

If that private reporting flow is unavailable, open a minimal public issue asking the maintainer to establish a private channel. Do **not** include vulnerability details in that issue.

A useful report includes:

- affected Vast version and platform;
- the security impact and affected trust boundary;
- reproduction prerequisites and concise reproduction steps;
- the least-sensitive proof needed to validate the issue;
- any known mitigations or conditions that prevent exploitation.

Allow reasonable time for confirmation, remediation, release coordination, and user update before publishing exploitable details. No response-time or bounty guarantee is implied unless a separate program says otherwise.

## Security architecture

Vast deliberately separates trusted application chrome from untrusted web content. The maintained technical model covers renderer/preload isolation, webviews, navigation policy, IPC, the password vault, extensions, Relay, Labs features, Electron Fuses, dependency gates, and release verification.

See [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md) for that architecture and [docs/IPC_SECURITY.md](docs/IPC_SECURITY.md) for focused IPC notes.

For privacy and data-handling behavior, see [docs/PRIVACY.md](docs/PRIVACY.md).
