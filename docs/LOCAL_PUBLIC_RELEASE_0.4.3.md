# Vast 0.4.3 direct public release

Use the 0.4.3 standard local release route from a clean, committed source tree. Keep the 0.4.2 profile and installer canaries isolated in the Guest 1 Windows account. The runner records the exact source commit and sealed candidate manifest; a code change requires a new `prepare` and `verify` for the new candidate.

```powershell
npm run release:local:public -- prepare
npm run release:local:public -- status
npm run release:local:public -- verify
```

Before `verify`, close all Vast windows in the test account. `verify` changes that account's application registration; set `VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E=YES` only in Guest 1. It checks clean installation and a standalone upgrade from public 0.4.2 with profile data preserved.

## Automatic update migration

The public 0.4.2 client downloaded a valid staged update but failed in its next-start installer handoff during the Guest 1 canary. The fixed helper in 0.4.3 cannot repair code already installed in 0.4.2 before that transition. Therefore 0.4.3 publishes two metadata assets:

- `latest.yml` is byte-for-byte the published 0.4.2 metadata. A 0.4.2 client sees its own version and does not stage the broken automatic transition.
- `stable-v2.yml` targets the current installer. Direct-install Vast 0.4.3 and later select this channel for future automatic updates.

The first 0.4.2 to 0.4.3 move requires a manual run of the 0.4.3 installer or standalone updater. Tell users this plainly in the public release notes. Keep the legacy feed pinned in subsequent stable releases until a separately tested migration retires it. A manual upgrade must preserve the user's direct-install profile.

Before publication, record these checks on the exact sealed candidate: clean install; public 0.4.2 standalone upgrade; legacy-feed hold with a real 0.4.2 client; 0.4.3 new-channel automatic updater canary; authenticated ChatGPT; extension runtime; Bitwarden; Proton Pass; basic iCloud; and profile persistence. The updater checks require actual process and installation evidence, not just metadata inspection. The formal password-manager acceptance matrix is a separate gate and is not implied by the basic canary.

Save a report in the runner's ignored state directory. Set a check to `true` only after it passes. Use the exact identity printed by `status`, with non-sensitive evidence references outside the `checks` object:

```json
{
  "version": "0.4.3",
  "sourceCommit": "<40-character source commit>",
  "candidateManifestSha256": "<64-character candidate manifest SHA-256>",
  "checks": {
    "cleanInstall": false,
    "publicUpgrade": false,
    "legacyFeedHold": false,
    "v2UpdaterCanary": false,
    "chatgptAuthenticated": false,
    "extensionRuntime": false,
    "bitwarden": false,
    "proton": false,
    "icloudBasic": false,
    "profilePersistence": false
  }
}
```

After `prepare`, `verify`, and all checks pass, review the exact candidate and report before running:

```powershell
npm run release:local:public -- publish --canary "<absolute-path-to-reviewed-report.json>"
```

Publication verifies the sealed bytes again, stages a GitHub draft, downloads and checks its assets, then makes the release public and verifies public URLs. Never replace an already published asset or reuse canary evidence from another source commit.
