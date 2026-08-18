# Contributing to Vast

Thanks for helping improve Vast. Keep changes focused, testable, and consistent with the local-first privacy and security boundaries documented in this repository.

## Prerequisites

- Node.js and npm compatible with CI
- Python 3 for asset verification and Video & Audio work
- Windows plus .NET 8 for updater integration tests and Windows packaging

Install locked dependencies:

```bash
npm ci
npm ci --prefix relay
python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt
```

Run the app with `npm run dev` and produce a non-installer build with `npm run build`.

## Validation

Before opening a pull request, run the checks relevant to your change. The normal baseline is:

```bash
npm run lint
npm test
npm run audit:ci
npm run release:audit
npm run build
```

Use `npm run test:app` for browser-shell or Electron integration changes. Updater work should also run `npm run updater:stage` and `npm run test:updater`. Relay work should run `npm run check --prefix relay` and follow the deploy checks documented in `relay/README.md`.

## Security-sensitive changes

Treat IPC, preload APIs, webview/session policy, navigation, updater/release verification, password storage/autofill, Relay signing, notices, Video & Audio process execution, and network discovery as security-sensitive. Explain the trust boundary in the pull request and add a regression test for any changed boundary.

Never commit secrets, certificates, private keys, tokens, passwords, private customer data, local profiles, absolute personal paths, or generated build/test output. Use documented environment variables, GitHub Actions secrets, and Cloudflare Secrets. Example values must be unmistakable placeholders.

## Dependencies and licenses

Keep dependencies pinned through their lockfiles. Explain why a new dependency is needed, check its maintenance and vulnerability status, and verify that its license is compatible with the intended source and binary distribution. Any vendored code, media, font, model, or executable needs recorded provenance and its required license/notice files before merge.

## Pull requests

- Keep the change scoped; avoid unrelated formatting or refactors.
- Describe user-visible and security/privacy impact.
- Include tests or explain why none are needed.
- Update documentation when commands, data handling, dependencies, or release obligations change.
- Do not commit generated release packages or benchmark output.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue containing exploitable details.
