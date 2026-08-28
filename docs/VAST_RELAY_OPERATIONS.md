# Vast Relay operations and security

This is the final operations runbook for Vast Relay and the private Vast
Control Panel. It contains no secret values.

## Deployed architecture

```text
Vast Browser
  |  POST /v1/checkin (public, hostile input)
  v
relay[-staging].vastbrowser.com
  vast-relay-public-{environment}
    |-- D1: minimal installations + active signed metadata
    `-- private R2: controlled immutable image reads

Administrator
  |  Cloudflare Access: exact identity + selected Cloudflare IdP
  v
controlpanel[-staging].vastbrowser.com
  vast-relay-admin-{environment}
    |-- verifies Cf-Access-Jwt-Assertion (RS256, iss, aud, exp, email)
    |-- D1: aggregate queries, signed CRUD, audit history
    |-- private R2: validated image writes/deletes
    `-- Worker Secret: Relay-only Ed25519 private key
```

The public and admin Workers are separate deployments. The public Worker has
no private key and no admin routes. A Control Panel outage does not prevent the
public Worker from serving already-signed records. A Relay outage remains
fail-soft in Vast.

## Domains and Cloudflare resources

| Environment | Public Relay | Private Control Panel | D1 | Private R2 |
|---|---|---|---|---|
| staging | `relay-staging.vastbrowser.com` | `controlpanel-staging.vastbrowser.com` | `vast-relay-staging` | `vast-relay-assets-staging` |
| production | `relay.vastbrowser.com` | `controlpanel.vastbrowser.com` | `vast-relay-production` | `vast-relay-assets-production` |

Worker names are `vast-relay-public-staging`,
`vast-relay-admin-staging`, `vast-relay-public-production`, and
`vast-relay-admin-production`. Both R2 buckets must have `r2.dev` and raw custom
domains disabled.

`GET|HEAD /health` on the public Worker reports only `{status, protocol}`. The
same minimal admin health route is behind Access and Worker JWT validation.

## Privacy and retention

The installation registry contains only:

- `install_id`: random installation UUID;
- `current_version`: actual running Vast version;
- `first_seen` and `last_seen`: server timestamps;
- `launch_count`: local cumulative application-launch count.
- `instance_kind`: `packaged`, `development`, `test`, or `unknown` for an older client.

Test cleanup must always target `WHERE instance_kind = 'test'` and must be
preceded by a remote D1 export. Never truncate `installations` and never infer a
test instance from its age, launch count, UUID, or version.

It does not contain IP, location, hardware/device identifiers, MAC address,
hostname, username, account identity, email, browsing history, URLs, searches,
tabs, bookmarks, extensions, session duration, message reads, clicks, or
dismissals. Source addresses are used only to form ephemeral rate-limit keys;
they are not persisted or paired with installation IDs in application logs.

Audit actor emails are administrative control-plane data, not browser
telemetry. Audit summaries contain only bounded operation metadata and never
tokens, keys, request bodies, or signed message bodies.

No automatic installation pruning is enabled. Any future retention change must
be documented, reviewed for operational impact, and implemented as an explicit
migration or operator procedure.

## Cloudflare Access

`relay/infra/access` defines two self-hosted applications. Each application:

- denies unmatched requests by default;
- allows one exact administrator email only;
- permits one selected identity provider only;
- requires reauthentication within six hours;
- enables binding, HttpOnly, and Lax SameSite cookies (Lax permits the Access top-level login redirect without allowing cross-site subresource requests);
- disables iframe, WARP authentication, and OPTIONS bypass;
- has no Everyone, broad email-domain, or Bypass policy.

Never create an Access application for either public Relay domain.

The deployed Access team domain is `vast-browser.cloudflareaccess.com`. The
selected IdP is `Cloudflare` (`d5c12185-788b-4b09-84b1-5d9cc4e0d770`). The
staging application ID/AUD are
`5056229e-1e8e-4c66-aa7e-9c00a8fccea0` /
`d57429a0aa7ef593c1a7eac956cfce93eb284f518625454b55b6a25787ef0866`;
the production values are `518846fd-4461-4954-aec7-4d1667fc0b99` /
`c17baacc642c0b105daaed3561596520d3702e60dac54876d000fc672e9690d3`.
Both applications share policy `2077a868-a2ba-4638-af99-1a5b758367f0`.

Access-native MFA is currently off because enabling it before the sole
administrator enrolls a recovery-safe authenticator can lock out the control
plane. Require MFA on the Cloudflare account/IdP now. To add Access-native MFA,
enroll and test an authenticator against staging first, retain a recovery path,
then enable the same requirement on production and update the Terraform model.

Provision Access before deploying the matching Control Panel route. Use a
short-lived Cloudflare token with `Access: Apps and Policies Write`, set the
Terraform variables through the environment, review the plan, then apply it.
Copy each output AUD into the matching `ACCESS_AUD` Wrangler variable. The team
domain belongs in `ACCESS_TEAM_DOMAIN`.

Access is not the only authorization layer. The Worker requires
`Cf-Access-Jwt-Assertion`, retrieves the account JWKS over HTTPS, permits only
RS256, and validates signature, exact issuer, exact application audience,
expiry, issued-at time, subject, and email. It never trusts
`Cf-Access-Authenticated-User-Email` by itself.

For browser state changes, the Worker also requires the exact same-origin
`Origin`, rejects cross-site Fetch Metadata, requires non-simple JSON or image
requests, and applies source-, actor-, and mutation-aware rate limits. This is
the CSRF model; Access binding and Lax SameSite cookies add defense in depth.

## D1 schema and migrations

`0001_initial.sql` creates installations, assets, broadcasts, releases, and the
Phase 1 audit table. `0002_control_panel.sql` adds first-seen/asset indexes,
broadcast draft/revision/update fields, release revision/update fields, and the
actor-aware audit schema. `0003_installation_browser.sql` adds composite
`last_seen + install_id` and `current_version + last_seen + install_id` indexes
for bounded Control Panel registry pages.

Before a production migration, export D1 outside the repository:

```powershell
npx wrangler d1 export DB --remote --env production --config public/wrangler.jsonc --output <secure-backup-path>\vast-relay-production.sql
npx wrangler d1 migrations list DB --remote --env production --config public/wrangler.jsonc
```

Apply staging first, validate, then production:

```powershell
npx wrangler d1 migrations apply DB --remote --env staging --config public/wrangler.jsonc
npx wrangler d1 migrations apply DB --remote --env production --config public/wrangler.jsonc
```

Production rollback uses a pre-migration export or D1 Time Travel. The checked-in
down SQL is only a reference for disposable local/staging databases because
SQLite column rollback is not safely atomic with signed records.

## Control Panel behavior

The dashboard queries only aggregate installation counts, 24-hour/7-day/30-day
activity and new-install counts, version distribution, and launch-count
aggregates. The private Instances view can browse the same five-field registry
in 25-row keyset pages, filter by recent activity or exact version, and find an
exact valid UUID. Its detail panel exposes only `install_id`, `current_version`,
`first_seen`, `last_seen`, and `launch_count`. It does not add timelines,
location, IP, device, account, message-interaction, or browsing data.

The Control Panel shell uses a single sticky top bar. The bundled Vast Relay
Architecture mark is centered between the Overview/Instances/Broadcasts and
Media/Updates/Audit navigation groups. Environment, verified Access actor,
active Relay key ID, and sign-out remain available in the authenticated session
menu.

The UI is a same-origin static bundle served through the authenticated Worker.
It renders remote strings with DOM text nodes, never `innerHTML`, and uses no
remote scripts, styles, images, or fonts. The CSP denies everything by default
and allows only same-origin scripts/styles/network/fonts and same-origin or
blob image previews. Framing, objects, forms to other origins, sensitive browser
capabilities, and referrers are blocked.

Broadcast bodies support only the locally implemented Vast Rich Text subset:
headings, bold, italic, ordered/unordered lists, quotes, dividers, inline code,
and fenced code blocks. The editor toolbar writes this plain-text notation and
the preview shares the desktop parser. HTML and Markdown links remain literal
text. Long bodies scroll inside the centered Relay modal while its title and
actions remain visible.

Every broadcast and release mutation uses a quoted revision `If-Match`. A stale
editor receives a conflict and must refresh. JSON bodies are capped at 16 KiB;
media is capped at 2 MiB.

## Broadcast workflow and kill switch

1. Create a draft using one allowed type.
2. Preview the structured text/media presentation locally in the panel.
3. Confirm version targeting and the UTC activation window.
4. Enable the record. The Worker validates it, resolves signed asset metadata,
   canonicalizes it, signs it server-side, persists it, then makes it active.
5. Verify through a staging client check-in before reproducing content in
   production.

Content-changing edits always produce a new canonical payload and Ed25519
signature. If signing or D1 persistence fails, the new content is not
published. The browser never receives the private key.

The kill switch is **Disable**. It writes `enabled = false` and a newly signed
payload. Public delivery reads D1 per check-in, so the record stops being
returned immediately apart from an already completed response. Do not delete a
problematic record merely to suppress it; disabling preserves the audit trail.
Permanent deletion is available only for draft, disabled, or expired records;
active and scheduled broadcasts must first be disabled or expired. The delete
operation retains its server-side administrative audit event.

## Media workflow

The panel accepts PNG, WEBP, and GIF only. The Worker checks Content-Type,
generated extension, magic bytes, and size; creates a server UUID key; computes
SHA-256; stores an immutable private R2 object; and records metadata in D1.
Original filenames never become object keys. HTML, SVG, scripts, executables,
installers, command files, and archives are rejected.

Broadcast payloads sign `{id, mime, sha256}`. Vast downloads media only from the
public asset endpoint and verifies MIME, magic bytes, size, and SHA-256 before
decoding it. Text can render if media fails. Referenced assets cannot be
deleted.

## Update-notice workflow

The release manager controls notice metadata only: SemVer, HTTPS release URL,
severity, optional minimum supported version, title, notes, publication time,
and enabled state. Publishing an enabled `critical` notice requires the exact
additional confirmation phrase shown in the panel.

Relay signatures authenticate display metadata. They do not authorize software
execution. `RELAY SIGNING KEY != SOFTWARE UPDATE SIGNING KEY`. Vast routes an
explicit Update action into the existing trusted updater only when that updater
already has a verified package; otherwise it opens an allowlisted release page.
The Control Panel cannot upload update binaries.

## Relay signing and rotation

Current private secret name: `RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64`. The
dormant rotation slot is `RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, selected
only when `RELAY_NEXT_KEY_ID` exactly equals `RELAY_KEY_ID`. Current public key
documents are in `relay/keys`. Do not reuse Vast package-signing or Authenticode
keys.

Safe rotation:

1. Generate an independent Ed25519 pair offline and assign a never-used key ID.
2. Add the next public key to Vast clients and ship it while the current key is
   still active.
3. Wait for sufficient client adoption.
4. Put the new private key in `RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64`, add
   its ID as `RELAY_NEXT_KEY_ID`, and deploy while `RELAY_KEY_ID` still selects
   the current key. The old Worker cannot accidentally use the dormant slot.
5. Change `RELAY_KEY_ID` to the next ID and deploy staging. The Worker fails
   closed if the next slot is missing; it never falls back under the new ID.
6. Verify new signatures with a multi-key client, then repeat in production.
7. Keep the old public key in clients through every old broadcast's maximum
   lifetime; disable old records before retiring it.
8. After the overlap, promote the next private key into the current secret while
   the Worker still selects the next slot, deploy without the next selector,
   then delete the next secret. Remove the old public key only in a later
   client release when no valid old payload can remain.

Never replace public bytes under an existing key ID and never remotely deliver
a new root key as trusted data.

## Staging and production deployment

From `relay/`:

```powershell
npm ci
npm run types
npm run check
$env:VAST_RELAY_ACCESS_CONFIRMED = 'YES'
npm run deploy:staging
```

The deploy script refuses an admin deployment until `ACCESS_AUD` is a real
64-character audience and the explicit Access gate is present. It builds/tests,
dry-runs, applies migrations, keeps R2 private, and deploys public before admin.
Initial signing-key creation additionally requires
`VAST_RELAY_INITIALIZE_SIGNING_KEY=YES`; subsequent deploys reuse the existing
secret without reading it.

Validate staging with the authorized browser identity. The optional automated
staging script additionally requires a narrowly scoped staging Service Auth
policy and service token supplied only through
`VAST_RELAY_ACCESS_CLIENT_ID`/`VAST_RELAY_ACCESS_CLIENT_SECRET`. Do not create a
Bypass rule for automation.

If a newly-created custom hostname is visible through public DNS but the
operator's recursive resolver still has a negative cache entry, the verifier
also accepts `VAST_RELAY_ADMIN_CONNECT_ADDRESS=<public Cloudflare edge IP>`.
This overrides lookup only inside the staging verifier; HTTPS still uses and
validates `controlpanel-staging.vastbrowser.com` for SNI and certificates. Do
not modify a workstation-wide hosts file for this test.

Staging acceptance must cover unauthorized denial, authorized panel load,
draft/preview/publish/signature delivery, tamper rejection in Vast, private R2
upload and digest verification, disable/kill switch, update severities, D1
timestamps/counts, and production count isolation. Remove all fixtures.

Production additionally requires the current staging-verification marker and:

```powershell
$env:VAST_RELAY_ACCESS_CONFIRMED = 'YES'
$env:VAST_RELAY_ALLOW_PRODUCTION_PROVISION = 'YES'
npm run deploy:production
```

Before deployment, verify production Access denies an unauthorized identity.
Afterward, production must contain no enabled test broadcasts or releases. Do
not publish a first production message during deployment.

## Backup, rollback, and incident response

List and roll back Worker versions independently:

```powershell
npx wrangler versions list --env production --config public/wrangler.jsonc
npx wrangler rollback --env production --config public/wrangler.jsonc
npx wrangler versions list --env production --config admin/wrangler.jsonc
npx wrangler rollback --env production --config admin/wrangler.jsonc
```

Incident priorities:

1. Problematic message: disable it in the panel and confirm an independent
   check-in no longer receives it.
2. Suspected admin compromise: revoke the Access session/identity, disable the
   Access allow policy, and stop admin Worker traffic while keeping public reads
   available.
3. Suspected Relay-key compromise: disable all broadcasts/releases, rotate to a
   pre-trusted next key, inspect audit/platform logs, and ship a client trust-set
   update if needed. A Relay key cannot sign executable packages.
4. Public abuse: tune Cloudflare rate limits/WAF without persisting requester
   addresses or placing Access on the public Relay.
5. D1 corruption: disable new publishing, export evidence, select a D1 Time
   Travel point, restore, then re-verify stored canonical payloads/signatures.
6. R2 failure: leave signed text active if appropriate; media failure is
   non-fatal.

For an emergency client-side Relay disable, ship Vast with the production Relay
compile-time gate disabled (`VAST_RELAY_PRODUCTION_ENABLED` absent/not `1`).
Development/internal builds can use `VAST_RELAY_ENABLED=0`. The endpoint cannot
be changed by a remote message. Backend-side containment can return normal
`messages: []` and `update: null`; it must not break the browser.

## Focused threat review

| Threat | Control |
|---|---|
| fake check-ins / install spoofing | public hostile-input model, strict schema, no claim of unique people/devices |
| D1 write amplification | tiny body, cheap validation, source and install rate limits, prepared upsert |
| Access misconfiguration | exact-email/default-deny IaC, unauthorized test before Worker deployment |
| forged Access header | Worker verifies JWT signature, issuer, audience, time, subject, and email |
| CSRF | Lax/binding cookies, exact Origin, Fetch Metadata, non-simple requests |
| XSS / malicious text | DOM text rendering, fixed structured schemas, restrictive CSP, no HTML |
| malicious asset / R2 abuse | private bucket, generated ID, MIME/extension/magic/size/hash validation |
| signature bypass / mismatch | deterministic canonicalization, key ID pinning, tamper tests in Worker and Vast |
| replay / rollback | signed enabled/time/version fields, client time and SemVer eligibility checks |
| unsafe update URL / IPC | HTTPS validation, explicit click, narrow IPC, existing updater trust only |
| key leakage | private Worker secret only; no public Worker, UI, log, or repository binding |
| outages / corruption | independent Workers, fail-soft client, empty degraded response, backups/Time Travel |

Review Cloudflare Access and account audit logs separately according to their
configured retention. Do not export them into D1 as a hidden analytics system.
