# Vast Browser production prerequisites

Status: **OPEN — BLOCKS THE NEXT PUBLIC DIRECT / MICROSOFT STORE RELEASE**

Last evidence review: **2026-08-30**

This file began as the 0.2.6 prerequisite record, but the actions below are
one-time production and provenance requirements. Renaming or skipping a version
does not satisfy them. Do not publish the next public Vast release until
every checkbox below is completed from live evidence and the result is recorded
against the exact final source commit.

Repository documentation may describe earlier successful deployments, but it is
not sufficient evidence to mark a live infrastructure requirement complete.
Re-run the production checks below. Replace `<full-final-source-sha>` with the
exact clean commit SHA that will be released.

## 1. Relay staging and production

- [x] Configure the required Cloudflare account/API and Access credentials in
  the operator environment without committing them.
- [ ] Deploy and verify Relay staging to generate a fresh marker bound to the
  final source commit, protocol, schema hash, D1 database/environment, endpoint,
  and key ID.
- [ ] Deploy Relay production only after the staging marker passes validation.
- [ ] Run the live production check-in gate with the exact final source SHA and
  confirm that its tagged synthetic `instance_kind=test` row is removed.

Evidence (2026-08-30): the supplied Cloudflare API token is active, belongs to
the configured 32-character account ID, can read all four isolated Relay/Hub D1
databases, can read the production installation table, and can update Worker
settings. The supplied Access client ID/secret are syntactically valid and the
supplied AUD exactly matches the staging Access application. A direct
service-token request to the staging control panel returned HTTP 200 after the
Access Service Auth policy was corrected. No Relay deployment, marker creation
or synthetic production write was attempted because those final operations
must be bound to the exact clean release SHA.

```powershell
npm run deploy:staging --prefix relay
npm run verify:staging --prefix relay
$env:VAST_RELAY_ALLOW_PRODUCTION_PROVISION='YES'
npm run deploy:production --prefix relay
$env:VAST_RELEASE_COMMIT='<full-final-source-sha>'
npm run verify:release-checkin --prefix relay
```

## 2. Extensions Hub D1 migration

- [x] Apply all pending migrations to the isolated staging D1 database.
- [x] Apply all pending migrations to the production D1 database.

Evidence (2026-08-28): both commands below returned `No migrations to
apply!` after migration `0004_native_rate_limiting.sql` had been applied.
The isolated database identities remain staging
`23f8714d-7c27-4756-b3b7-9f884cd76b4d` and production
`dc35981e-2b78-4884-bf70-2620f4472251`.

```powershell
npx wrangler d1 migrations apply DB --remote --env staging --config extensions-hub/wrangler.jsonc
npx wrangler d1 migrations apply DB --remote --config extensions-hub/wrangler.jsonc
```

## 3. Private signer Worker

- [x] Store the staging private key in the staging signer Worker.
- [x] Store the production private key in the production signer Worker.
- [x] Confirm that each private key matches the corresponding key ID and public
  trust root compiled into Vast. Never generate a replacement key casually.
- [x] Copy both source private keys to an encrypted external vault or offline
  medium controlled by the operator. A second folder on the same PC does not
  count as a backup.
- [ ] Ship a Vast build containing `vast-hub-2026-02` before approving any new
  production Hub release signed by that key. Existing public clients trust only
  the legacy key and must keep receiving the existing legacy-signed release.

Evidence (2026-08-29): a controlled Ed25519 rotation created independent keys
`vast-hub-2026-02` and `vast-hub-staging-2026-02`. The source copies are in
`C:\secure\vast-hub-keys` with inherited ACLs removed and access limited to the
operator account and SYSTEM. Their public-key SHA-256 fingerprints are
`9d1f6f35a82f45b2482db9b4be4df232a8166c1348fc2b82c437acd613bbfae8`
(production) and
`60341ca29aa9c27acc8d59ecbd7e12d87863a9c659ad2c710b7b4ecae5a3f753`
(staging). Both private values were installed only in their respective signer
Workers. Live, deployment-bound Ed25519 proofs verified each private key
against its expected public key. The prior production public key remains a
compiled `legacy` trust root because the existing immutable 0.3.8 release is
still signed by `vast-hub-2026-01`. On 2026-08-30 the operator confirmed that
both source keys were copied to an encrypted external backup; its location is
intentionally not recorded in the repository.

```powershell
npx wrangler secret put HUB_SIGNING_PRIVATE_KEY_PKCS8 --env staging --config extensions-hub/signer/wrangler.jsonc
npx wrangler secret put HUB_SIGNING_PRIVATE_KEY_PKCS8 --config extensions-hub/signer/wrangler.jsonc
```

## 4. Worker deployment order

- [x] Deploy the staging signer before the staging Hub.
- [x] Deploy the production signer before the production Hub.
- [x] Confirm that the signer Workers have no public route, `workers.dev`
  endpoint, or preview URL and are reachable only through their service binding.

Evidence (2026-08-29): Wrangler deployed the staging signer before Hub version
`0ddc0050-359c-47a4-bbcc-81cd0c1b109c`, and the production signer before Hub
version `203969f1-6925-46e9-9669-769ecbfbbf72`. Current signer versions are
staging `5dc58b65-ed2a-44af-a1aa-7e6b048cb7c7` and production
`a6311b01-41f6-4d0d-9dd2-5f0577d90b48`. Both signer deployments reported
`No targets deployed`; their checked-in configs set `workers_dev: false`,
`preview_urls: false`, define no routes, and the public Hubs reach them through
the `HUB_SIGNER` service binding.

```powershell
npx wrangler deploy --env staging --config extensions-hub/signer/wrangler.jsonc
npx wrangler deploy --config extensions-hub/signer/wrangler.jsonc
npx wrangler deploy --env staging --config extensions-hub/wrangler.jsonc
npx wrangler deploy --config extensions-hub/wrangler.jsonc
```

## 5. Cloudflare observability and production readiness

- [x] Configure query-string redaction for the production Hub Worker.
- [x] Configure query-string redaction for the staging Hub Worker.
- [x] Configure query-string redaction for the production signer Worker.
- [x] Configure query-string redaction for the staging signer Worker.
- [x] Run the production Hub readiness gate and confirm health, catalog access,
  descriptor verification, and signing compatibility with the compiled trust
  root.

Evidence (2026-08-30): the Cloudflare Workers settings API was used for all
eight Hub, signer and Relay staging/production Workers. Each setting was read
back from Cloudflare and confirmed `redact_query_string=true`,
`invocation_logs=false`, persistent log sampling at 20% staging / 5%
production, and trace sampling at 5% staging / 1% production. The configuration
script now sends the complete API-required observability object and fails if
Cloudflare does not persist every required field. Production readiness again
returned `ok: true`: active signer key `vast-hub-2026-02`, existing descriptor
key `vast-hub-2026-01`, verified extension
`kbbfoeemomglhdhohnkcnfnpikedcoka`, version `0.3.8`. Staging health, signer
proof and the empty catalog also passed during signer rotation.

```powershell
npm run observability:production --prefix extensions-hub
node scripts/configure-worker-observability.mjs vast-extensions-hub-staging vast-extensions-hub-signer-staging
npm run hub:verify:production
```

## 6. Remove obsolete public-Hub secrets

Only after the signer service binding and production readiness checks pass:

- [x] Delete `HUB_SIGNING_PRIVATE_KEY_PKCS8` from the public Hub Worker.
- [x] Delete `HUB_RATE_LIMIT_SECRET` from the public Hub Worker after native
  Cloudflare Rate Limiting is confirmed operational.
- [x] Verify that neither secret remains visible in the public Hub Worker's
  binding/secret inventory.

Evidence (2026-08-29): production public Hub secret inventory now contains only
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; staging public Hub contains no
secrets. Each private signer contains exactly
`HUB_SIGNING_PRIVATE_KEY_PKCS8`. Native rate-limit bindings remained active and
both catalog/readiness checks passed after deletion. The deleted public-Hub
secret values are not recoverable from Cloudflare; the signer keys remain in
the isolated signer Workers and the protected source directory described above.

## 7. Repair the existing public v0.2.5 source tag

**Resolved on 2026-08-28:** the public `v0.2.5` tag now truthfully identifies
the source represented by the published 0.2.5 artifacts.

- [x] Export the public source snapshot from Vast source commit
  `d5964bb7f171f3c4f7aa038059e46e8e3482c9a0`, which is the source commit recorded
  by the published 0.2.5 release manifest.
- [x] Verify that the exported `package.json` says `0.2.5` and its provenance
  metadata names the same source commit.
- [x] Commit that snapshot to `vstxx/vast-public`.
- [x] Move/recreate the public `v0.2.5` tag only after independently verifying
  the snapshot and record the old and replacement public commit IDs in the
  readiness report.
- [x] Re-run published-release verification against the corrected tag and the
  existing 0.2.5 artifacts.

Evidence (2026-08-28): the previous tag target was public commit
`d470b74e299cb36e4f5a98ba30a0b8d80f5045f2`. The corrected snapshot is public
commit `0c2c80b3718f45668a84af429a41387cf7f8e59b`; annotated tag object
`56d1656af4450c1bbec307183e56520e6c9ae051` points to it. The production
published-release verifier downloaded every required artifact and returned
`ok: true`, `version: 0.2.5`, source commit
`d5964bb7f171f3c4f7aa038059e46e8e3482c9a0`, and the historically accurate
`unsigned-public-beta` signature policy. The old unsigned release and its
`PUBLIC-UNSIGNED-BETA.md` marker remain unchanged.

This retag is a deliberate public-history correction. It must not be performed
as an incidental side effect of a build or deployment command.

## 8. Windows distribution and final release

- [x] Configure the protected `public-release` GitHub environment with the
  required Cloudflare credentials, release token and exact Partner Center MSIX
  identity.
- [x] Use the correct Store signing model: submit the production MSIX unsigned
  and let Partner Center sign it after certification. Keep a recursive,
  header-based inventory of every PE inside the unpacked MSIX as evidence; do
  not require an unrelated publisher certificate for this Store route.
- [ ] Build the direct artifact from the exact final source SHA and verify its
  declared signature policy. The current route must report
  `unsigned-public-release`, contain `PUBLIC-UNSIGNED-RELEASE.md`, and have
  `NotSigned` Vast executables rather than pretending to be signed.
- [ ] Pass the install, launch, Windows Default Apps registration and
  clean-uninstall E2E on the isolated Windows runner.
- [ ] Run the separate **Public unsigned release** workflow only after every
  applicable infrastructure check above is green and record the successful run.

Evidence (2026-08-30): the protected GitHub `public-release` environment now
contains `VAST_RELEASE_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `VAST_MSIX_IDENTITY_NAME`, `VAST_MSIX_PUBLISHER` and
`VAST_MSIX_PUBLISHER_DISPLAY_NAME`. The owner explicitly authorized the current
direct release to remain unsigned. The dedicated unsigned workflow keeps the
signed workflow unchanged, requires the exact risk acknowledgement, hashes,
source provenance, updater/upgrade checks, clean uninstall and re-verification
of published bytes, and publishes stable as a normal GitHub Release. The Store
workflow does not require `WIN_CSC_LINK` or `WIN_CSC_KEY_PASSWORD`: Partner
Center signs the certified MSIX. It still recursively inventories all detected
PE files by header. A future signed direct release would use those two secret
names, but the currently authorized direct release is unsigned.

## Completion record

When all actions pass, replace the status at the top with `COMPLETE` and add:

- completion date and operator;
- exact final Vast source SHA;
- deployed Relay, Hub and signer Worker versions;
- D1/schema hash and environment identity;
- active Relay/Hub signing key IDs;
- corrected public `v0.2.5` tag old/new commit IDs;
- links or command output references proving the checks;
- the final release workflow run used for publication and its declared
  signature policy.

The completion record must be evidence-based. Do not infer completion from a
successful local build or from an older deployment note.
