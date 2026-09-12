# Vast release guide

Vast releases are built from an exact source revision and are expected to fail closed when required verification inputs are missing. This file documents the durable release model; version-specific investigation notes and one-off readiness worklogs are intentionally not part of the public documentation set.

## Release principles

- Start from an exact, clean source commit.
- Keep signing keys, certificates, passwords, Cloudflare credentials, and release tokens outside Git.
- Run validation before expensive packaging or publication.
- Bind distributed artifacts to the source commit and version in machine-readable metadata.
- Publish hashes and the third-party license/source material required by the shipped runtime.
- Re-download published artifacts and verify the production bytes rather than trusting only local output.
- Never silently replace the assets behind an already published version/tag.

## Validation baseline

Install locked dependencies first:

```bash
npm ci
npm ci --prefix relay
python -m pip install -r resources/avidae/requirements.txt -r resources/avidae/requirements-build.txt
```

Run the canonical local preflight before dispatching a workflow. It builds and tests locally, writes its report under `.vast-build/release-preflight/`, and exports a disposable worktree snapshot for audit and secret scanning. It never publishes, pushes, tags, deploys or installs a Store package:

```bash
node scripts/setup-gitleaks.cjs
npm run release:preflight
```

The individual baseline commands remain available for investigating a failure:

```bash
npm run audit:ci
npm run lint
npm run check --prefix relay
npm test
npm run release:audit
npm run release:version-check
npm run test:fuses:integration
npm run test:electron-version
npm run test:app
npm run updater:stage
npm run test:updater
```

Use the additional Store, extensions, package, and live-service gates required by the chosen distribution route. [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) is the maintained checklist.

## Distribution routes

### Direct Windows release

Both public workflows default to `publish=false`: they build and verify a candidate and audit and secret-scan its public source snapshot. Nothing is pushed to the public repository in that mode. Keep the successful run ID and exact source SHA.

The unsigned workflow stores only the immutable files from `scripts/release-files.cjs`, build metadata and their SHA-256 manifest as assets of a **private draft release in vstxx/vast**. Its temporary `candidate-v<version>-<channel>-unsigned-<full SHA>` tag points at the exact source commit. This uses the job's `GITHUB_TOKEN` with `contents: write` and `actions: read`, not Actions artifact storage or the public release token. Every asset must be smaller than 2 GiB. Existing matching bytes are reused; conflicting bytes fail without overwrite. There is no automatic expiry: a failed publication retains staging; successful public verification deletes only that private draft and its temporary tag. The signed workflow still retains its Actions candidate for 7 days.

To publish later, dispatch the **same workflow at the same source SHA and channel**, set `resume_run_id` to the candidate run ID, and explicitly set `publish=true` (plus the unsigned risk acknowledgement where applicable). The workflow restores original bytes, verifies the complete canonical file/hash inventory and existing package integrity gates, and never rebuilds that candidate. Unsigned resume reconstructs the runtime solely from the verified original update ZIP for the unchanged runtime, ASAR, fuse, signature and FFmpeg checks. Existing public tags must match the exported tree and provenance. Existing assets must match SHA-256; missing draft assets can be uploaded, conflicting assets are never overwritten. Partial publication keeps the private candidate for retry. After successful publication and cleanup, do not dispatch another resume against the removed candidate. Missing/expired candidates require investigation; do not replace already published bytes with a rebuild.

Direct releases produce the Windows installer, portable executable, updater/bootstrapper payload, update manifests, checksums, release provenance, and required third-party source assets.

The preferred signed route requires a publicly trusted Authenticode certificate and validates the signer plus timestamp. If those credentials are unavailable, that route must fail closed.

The explicitly supported public-unsigned route is separate and must be deliberately acknowledged. It does not claim publisher identity. Its release notes and marker must state that Windows can report **Unknown publisher** / SmartScreen warnings, and all expected top-level executables must verify as unsigned rather than accidentally mixing trust states.

### Microsoft Store

Store packaging produces an MSIX with the exact Partner Center identity and disables Vast's direct updater. Partner Center signs an accepted Store package after certification. Store-specific package verification must still validate manifest identity, architecture, assets, runtime hardening, distribution-channel metadata, and the absence of direct-updater payloads.

Product version comes from `package.json`. `scripts/release-config.json` separately records the previous public release, default Store package version and previous consumed Store version. `VAST_MSIX_PACKAGE_VERSION` and `VAST_MSIX_PREVIOUS_PACKAGE_VERSION` override the Store values; the candidate must be strictly higher, with fourth component zero. Confirm the actual highest consumed number in Partner Center before building. Store filenames include both versions. The Store workflow only produces a candidate and never submits it.

Installed direct and Store builds use the same installed-profile policy; portable builds use their own adjacent data root. See [docs/DATA_MIGRATION_AND_STORAGE.md](docs/DATA_MIGRATION_AND_STORAGE.md).

## Runtime and third-party source

The packaged Video & Audio runtime is prepared and verified before public distribution. Critical runtime components are hashed and checked by release tooling.

The shipped FFmpeg build is GPL-covered and must be accompanied by the exact corresponding-source/provenance material required by the maintained compliance gate. Do not remove those source assets merely to make a release page smaller.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/OPEN_SOURCE_LICENSE_AUDIT.md](docs/OPEN_SOURCE_LICENSE_AUDIT.md).

## Public source snapshot

Release automation exports a sanitized source snapshot with `scripts/export-public-source-snapshot.mjs` and publishes it to `vstxx/vast-public`.

The snapshot records:

- the public version;
- the originating canonical source commit;
- the export timestamp;
- intentional exclusions of private, deployment-only, operator-only, or historical worklog material.

The public CI workflow is normalized to the public repository's `main` branch during export. Release tags are the source anchors for their corresponding binary releases.

## Local release preparation

Copy `.env.release.example` to the ignored `.env.release.local` and provide only the values required by the route you are testing. Never commit the populated file.

Useful entry points include:

```bash
npm run release:check:local
npm run release:local
npm run release:public-unsigned
```

Local success is not, by itself, authorization to publish. Public workflows add protected credentials, production service checks, artifact re-download verification, and immutable GitHub release publication.

## CI cost

The normal Windows CI workflow skips documentation-only changes and avoids release-package/MSIX construction on ordinary pull requests. Full packaging remains part of main/tag or dedicated release validation where it provides useful evidence.
