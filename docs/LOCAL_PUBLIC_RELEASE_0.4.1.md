# Vast 0.4.1 local public release

This is the intentionally unsigned direct-install route. It does not submit an MSIX to Microsoft Store and does not dispatch GitHub Actions. The existing workflow remains available for later releases; this route uses the same source, package and published-byte checks locally.

Run from a clean `master` commit with Node 24, Python 3.13, .NET 8, GitHub CLI authentication, Cloudflare Wrangler authentication and the existing ignored `.env.release.local`. Never paste credentials into a command, log, issue or canary report. The runner fixes channel `stable`, previous public version `0.3.0`, repo `vstxx/vast-public`, production Relay and unsigned policy. It rejects conflicting release settings.

```
npm run release:local:public -- prepare
npm run release:local:public -- status
npm run release:local:public -- verify
```

`prepare` installs locked dependencies, checks the pinned compatibility runtime, runs preflight and production Relay/Hub checks, prepares the media runtime, archives any previous generated `release/` into its ignored state directory, builds 0.4.1, verifies package/updater/secret gates, exports an audited exact-commit source snapshot, and seals and stages the candidate. `verify` tests clean install/uninstall and the real public 0.3.0 to staged 0.4.1 upgrade. Logs, child PIDs, exit codes, candidate SHA-256 and phase status live at the `statePath` shown by `status`. A running or interrupted step is never silently duplicated. After inspecting its log and confirming its process has stopped, use `--retry`; a failed build additionally needs **both** `--retry --retry-build`, which archives its partial `release/` directory before attempting another build. Neither retry may change the release source commit.

Before `verify`, switch to an isolated Windows test account. The clean-install test changes that account's application registration. Set `VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E=YES` only there; the local runner refuses this gate even if `CI=true` unless the acknowledgement is explicit. Do not run it against your everyday Vast profile.

Use a separate Windows test account/profile and an isolated updater feed pointing to the **staged candidate bytes**, not the production release URL. Record the following checks only after actually performing them: clean install, 0.3.0 upgrade, automatic updater canary, logged-in ChatGPT without tab crash, extension runtime activation, Bitwarden installation/use, Proton Pass installation/use, basic Apple upstream iCloud flow, and profile/data persistence. Never include vault contents, credentials, cookies or tokens. The exhaustive formal password-manager gate remains open and is not represented by this basic canary.

Save a JSON report outside tracked source, preferably under the runner's ignored state directory. Set each value to `true` only with evidence; add non-sensitive evidence references separately. The three identity values must match `status` and the staged `release-candidate.json` SHA-256:

```json
{
  "version": "0.4.1",
  "sourceCommit": "<40-character final commit SHA>",
  "candidateManifestSha256": "<64-character SHA-256>",
  "checks": {
    "cleanInstall": false,
    "publicUpgrade": false,
    "updaterCanary": false,
    "chatgptAuthenticated": false,
    "extensionRuntime": false,
    "bitwarden": false,
    "proton": false,
    "icloudBasic": false,
    "profilePersistence": false
  }
}
```

Only after `prepare`, `verify` and every canary check pass:

```
npm run release:local:public -- publish --canary "<absolute-path-to-reviewed-report.json>"
```

Publication verifies staged hashes again, publishes the audited source snapshot/tag with `[skip ci]`, uploads immutable assets to a draft, redownloads and verifies draft bytes, makes the release public, then verifies public URLs. If interrupted, inspect `status` and resume the same candidate with `--retry`; never rebuild or overwrite public assets. Check GitHub Actions runs in both repositories after pushes. A release appearing publicly exposes the stable update to all users, so the website and docs promotion must happen only after public verification.
