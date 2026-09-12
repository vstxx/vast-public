# Release checklist

Use this checklist for each public Vast release. Route-specific checks that do not apply should be explicitly treated as not applicable rather than silently skipped.

## Source and dependencies

- [ ] Release starts from the intended clean source commit.
- [ ] `package.json` and lockfile versions are consistent.
- [ ] Locked JavaScript, Relay, and Python build dependencies install successfully.
- [ ] Dependency vulnerability gates pass.
- [ ] Full-history secret scanning has no unreviewed finding.
- [ ] `npm run release:preflight` passes on the reviewed source; local/manual blockers are resolved explicitly.
- [ ] Generated public snapshot excludes `audit/` and passes its own audit and Gitleaks before any push.
- [ ] No private key, certificate, password, token, local profile, generated release package, or personal absolute path is introduced into the source snapshot.

## Build and tests

- [ ] TypeScript/lint validation passes.
- [ ] Desktop and Relay test suites pass.
- [ ] Extensions typecheck/tests and relevant E2E coverage pass.
- [ ] Electron application E2E passes for affected browser behavior.
- [ ] Updater staging and upgrade tests pass where the route uses the direct updater.
- [ ] Electron version/browser-policy checks pass.
- [ ] Real packaged Electron Fuses are applied and read back successfully.
- [ ] Package/runtime verification passes on the actual built artifact.

## Privacy and security boundaries

- [ ] Web content remains isolated from Node and generic privileged filesystem/shell APIs.
- [ ] Sensitive IPC surfaces remain bound to their local feature/security policy.
- [ ] Password-vault and autofill origin/sender binding tests pass if touched.
- [ ] Relay production configuration carries only the documented bounded operational data.
- [ ] Labs or extension changes do not silently widen permissions or remote-control capabilities.
- [ ] Diagnostics and release metadata contain no credentials or private user content.

## Direct Windows route

- [ ] Installer, portable executable, updater/bootstrapper, update payload, and manifests are produced once for the authorized version.
- [ ] Signed route: required Vast executables have the expected Authenticode signer and trusted timestamp.
- [ ] Public-unsigned route: required Vast executables verify as unsigned and the release warning/marker is present.
- [ ] Previous-public-version upgrade preserves the supported data/profile state.
- [ ] Clean install, launch, registration, and uninstall behavior is verified on an isolated Windows environment.
- [ ] Published hashes match locally verified files after re-download.

## Microsoft Store route

- [ ] MSIX uses the exact Partner Center identity and monotonic Store version.
- [ ] Direct updater payloads are absent and Store update ownership is reflected in packaged metadata.
- [ ] Manifest, architecture, assets, runtime hardening, and recursive PE inventory pass verification.
- [ ] Installed launch/upgrade/profile/default-browser/uninstall checks pass on an isolated Windows account or runner.
- [ ] WACK/certification checks required for submission pass.

## Third-party compliance

- [ ] Runtime license/notice inventory is complete.
- [ ] FFmpeg provenance and exact corresponding-source archive pass the maintained compliance gate.
- [ ] Corresponding-source and provenance assets are uploaded beside every release that ships the covered binaries.
- [ ] Release checksums include the required verification/compliance assets.

## Publication

- [ ] `.vast-source-provenance.json` matches the release version and originating canonical source commit.
- [ ] Public source tag and release version agree.
- [ ] Release notes accurately state signature status and material limitations.
- [ ] Draft/repository assets are re-downloaded and verified before publication.
- [ ] Published production URLs are verified once more after release.
- [ ] The version/tag is never reused for different bytes.
