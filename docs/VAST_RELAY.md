# Vast Relay backend and protocol

This document covers the Cloudflare-hosted backend, protocol, migrations, and
deployment tooling. The Electron integration is documented in
[VAST_RELAY_CLIENT.md](VAST_RELAY_CLIENT.md), and the final private control
plane runbook is [VAST_RELAY_OPERATIONS.md](VAST_RELAY_OPERATIONS.md).

## Architecture

```text
Vast Browser (Phase 2)
        |
        | HTTPS POST /v1/checkin
        v
vast-relay-public-{environment}
        |-- D1: installation upsert + signed-data reads
        |-- R2: controlled immutable image reads
        `-- Workers Rate Limiting

Authenticated administrator / Cloudflare Access
        |
        | authenticated /v1/admin/*
        v
vast-relay-admin-{environment}
        |-- D1: broadcast/release/asset metadata CRUD + audit
        |-- R2: validated image writes/deletes
        `-- Worker Secret: independent Relay Ed25519 private key
```

The public Worker has no admin routes and no private-key binding. The admin
Worker is a separate deployment and every route, static asset, and health check
requires Cloudflare Access plus application-level JWT verification. The Worker
validates Access's signature, issuer, audience, expiry, subject, and email claim;
it does not trust a user-controlled email header.

Relay and the existing Vast updater are separate trust domains. Relay release
records are signed warnings/metadata only. They never carry or execute packages,
and they do not replace `electron-updater`, Authenticode, GitHub release trust,
or the existing updater state machine. Vast's existing signed Notices code is
the closest Phase 2 integration point, but its current feed format must not be
silently treated as Relay protocol v1.

## Environments and resources

| Environment | Public URL | Admin URL | D1 | Private R2 |
|---|---|---|---|---|
| staging | `https://relay-staging.vastbrowser.com` | `https://controlpanel-staging.vastbrowser.com` | `vast-relay-staging` | `vast-relay-assets-staging` |
| production | `https://relay.vastbrowser.com` | `https://controlpanel.vastbrowser.com` | `vast-relay-production` | `vast-relay-assets-production` |

Wrangler definitions live in `relay/public/wrangler.jsonc` and
`relay/admin/wrangler.jsonc`. Bindings are non-inherited and repeated for each
environment so staging cannot fall through to production. R2 buckets remain
private: the deployment script explicitly disables `r2.dev` and fails if a raw
R2 custom domain is detected.

Production deployment has two code-enforced gates: a successful staging
verification marker and `VAST_RELAY_ALLOW_PRODUCTION_PROVISION=YES`. Provisioning
production does not modify or activate a Vast desktop release.

## Threat model and privacy boundary

`POST /v1/checkin` and `GET /v1/assets/*` are hostile public endpoints. Relay
assumes callers can forge installation IDs, versions, counts, headers, and
traffic volume. Protections include bounded streamed bodies, exact JSON shapes,
strict SemVer/UUID validation, fixed prepared SQL, fixed response types,
Cloudflare-native rate-limit bindings, R2 metadata lookup through D1, extension
and MIME allowlists, image magic-byte validation, SHA-256 integrity, and passive
signed payloads.

The only installation columns are:

- `install_id`
- `current_version`
- `first_seen` (server time)
- `last_seen` (server time)
- `launch_count`
- `instance_kind` (`packaged`, `development`, `test`, or `unknown` for legacy clients)

Relay does not collect or persist IP addresses, hardware/device IDs, MAC
addresses, usernames, hostnames, accounts, email, URLs, searches, history, tabs,
bookmarks, extensions, session duration, page activity, or message
read/click/dismiss events. A requester address is hashed ephemerally to form a
per-source Cloudflare rate-limit key; neither the raw address nor the hash is
written to D1 or application logs. `install_id` is also used as a separate
ephemeral rate-limit key. Cloudflare's normal platform logs/abuse controls remain
subject to the account's configured retention policy.

Admin audit data is control-plane infrastructure, not client telemetry. It
stores event type, entity type/id, verified Access actor, bounded safe summary,
and server timestamp.

## D1 schema and migrations

`relay/migrations/0001_initial.sql` creates:

- `installations`, with indexes on `last_seen` and `current_version`;
- `assets`, containing private R2 object keys plus MIME, size, and SHA-256;
- `broadcasts`, normalized delivery/filter fields plus canonical signed bytes;
- `releases`, normalized update-notice fields plus canonical signed bytes;
- `admin_audit`, containing bounded control-plane events.

`0002_control_panel.sql` adds dashboard indexes, optimistic revisions/drafts,
and the actor-aware audit model.

`0003_installation_browser.sql` adds composite indexes used by the private,
bounded installation registry browser. It changes no collected fields.

SQLite `STRICT` tables, `CHECK` constraints, foreign keys, and prepared Workers
statements provide defense in depth. Apply staging migrations with:

```bash
cd relay
npx wrangler d1 migrations list DB --remote --env staging --config public/wrangler.jsonc
npx wrangler d1 migrations apply DB --remote --env staging --config public/wrangler.jsonc
```

Replace `staging` with `production` only after staging has passed. Wrangler
captures a pre-migration D1 backup. Never apply a schema manually only in the
dashboard.

## Public protocol v1

### `POST /v1/checkin`

Required content type: `application/json` (an optional UTF-8 charset is allowed).
Maximum body: 2 KiB. No client secret is required or accepted.

```json
{
  "protocol": 1,
  "install_id": "b2b65f31-4c31-4da3-9c2c-e5d28f8ca130",
  "current_version": "0.2.7",
  "launch_count": 152,
  "instance_kind": "packaged"
}
```

UUIDs must use an RFC variant and version 1-8. Version strings are strict
SemVer 2.0.0, matching Vast's current `0.2.7` format; `v` prefixes, partial
versions, whitespace, leading zeroes, and invalid prerelease identifiers fail.
`launch_count` is an integer from 0 through 2,147,483,647. `instance_kind`
classifies the runtime without exposing user or device data. Clients using the
older schema are retained as `unknown`.

On first check-in, D1 receives server-generated `first_seen` and `last_seen`.
Later check-ins preserve `first_seen`, advance `last_seen`, update the validated
version, keep `launch_count` monotonic with SQLite `MAX`, and update a known
instance kind without allowing a legacy `unknown` check-in to erase it.

```json
{
  "protocol": 1,
  "server_time": "2026-08-10T21:00:00.000Z",
  "messages": [],
  "update": null
}
```

Each message or update, when present, is a signed envelope:

```json
{
  "key_id": "relay-2026-01",
  "payload": { "schema": "vast-relay-broadcast-v1" },
  "signature": "base64-Ed25519-signature"
}
```

Only `welcome`, `seasonal`, `announcement`, `security`, and `update_notice`
broadcast types exist. There is no HTML, CSS, JavaScript, command, shell,
download-and-run, remote setting, or executable payload field.

The signed `body` remains a bounded plain string. Vast may interpret a small,
locally defined presentation subset for headings (`#` through `###`), bold
(`**text**`), italic (`*text*`), ordered/unordered lists, quotes, dividers,
inline code, and fenced code blocks. This is not general Markdown: HTML and
Markdown links are not parsed, no remote styling is accepted, and every value
is rendered through React/DOM text nodes. The Control Panel preview uses the
same parser as the desktop client so authored announcements remain predictable.

Delivery selects enabled broadcasts whose server-side active window contains
the check-in time and whose optional min/max SemVer includes the client. It caps
delivery at 40 ordered by priority. The update field contains the highest
enabled release version newer than the client, with severity limited to
`optional`, `recommended`, `important`, or `critical`.

If D1 fails after request validation, check-in returns HTTP 200 with the normal
empty response and `X-Vast-Relay-Degraded: database`. A Relay outage must never
become a browser startup failure.

### `GET|HEAD /v1/assets/:assetId`

IDs are one lowercase filename segment ending in `.png`, `.webp`, or `.gif`.
The Worker first resolves immutable metadata in D1, then fetches the exact
private R2 key. It never lists the bucket or derives an arbitrary key from a raw
path. Responses include `Content-Type`, `Content-Length`, quoted R2 `ETag`, an
immutable cache policy, HSTS, and `X-Content-Type-Options: nosniff`.

Missing/R2-failed media is non-fatal to Phase 2: render the signed text without
media.

## Canonicalization and signing

Relay uses an independent Ed25519 key pair. It is not an update/package signing
key. The admin Worker imports a base64 DER PKCS#8 private key from
`RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64`; the public DER SPKI key is recorded in
`relay/keys/<key_id>.json` and will be embedded in Vast during Phase 2.

Canonical serialization is deterministic UTF-8 JSON with these rules:

1. payload schemas contain only their documented exact fields;
2. object keys are recursively sorted by JavaScript UTF-16 code-unit order;
3. arrays retain order;
4. strings and booleans use JSON serialization; null is explicit;
5. numbers must be safe integers and use base-10 without decoration;
6. `undefined`, non-finite/fractional numbers, functions, and other values fail;
7. stored canonical text must equal a fresh canonical serialization byte for
   byte before the public Worker delivers it.

The signature is Ed25519 over the UTF-8 canonical string. Asset `{id, sha256,
mime}`, active expiry, content, enabled flag, key ID, and all other payload fields
are signed. Tests prove that changing title, body, expiry, asset ID/digest, key,
or signature fails verification.

For rotation, add a new key ID/public key, provision the new private secret,
change `RELAY_KEY_ID`, and keep old public keys in Phase 2 through the maximum
old-payload lifetime. Never replace public bytes under an existing key ID.

## Admin API

All routes require a valid `Cf-Access-Jwt-Assertion`. State changes additionally
require the exact Control Panel Origin; there is no wildcard CORS or OPTIONS
bypass. JSON bodies are capped at 16 KiB and edits use quoted revision ETags.

- `GET /v1/admin/session`
- `GET /v1/admin/dashboard`
- `GET /v1/admin/installations` (bounded keyset pages; optional activity,
  exact-version, and exact-install-ID filters)
- `GET /v1/admin/installations/:uuid`
- `GET /v1/admin/audit`
- `GET|POST /v1/admin/broadcasts`
- `GET|PUT|DELETE /v1/admin/broadcasts/:uuid`
- `GET|POST /v1/admin/releases`
- `GET|PUT|DELETE /v1/admin/releases/:semver`
- `GET /v1/admin/assets`
- `PUT /v1/admin/assets`
- `GET|HEAD /v1/admin/assets/:assetId/content`
- `DELETE /v1/admin/assets/:assetId`

Asset upload accepts raw bytes, is capped at 2 MiB, and requires an exact
extension/Content-Type/magic-byte match. Allowed formats are PNG, WEBP, and GIF.
Objects are immutable per ID and stored with R2's SHA-256 check plus D1 metadata.
Referenced assets cannot be deleted.

Release URLs and broadcast action URLs must be HTTPS without embedded
credentials. They are data for Phase 2 to validate/present; release URLs do not
grant installation authority.

## Deployment and staging verification

Wrangler 4.120.1 or newer is required. From `relay/`:

```powershell
npm ci
npm run check
npx wrangler login
$env:VAST_RELAY_ACCESS_CONFIRMED = 'YES'
$env:VAST_RELAY_INITIALIZE_SIGNING_KEY = 'YES'
npm run deploy:staging
npm run verify:staging
```

The deploy script uses Wrangler's named-resource provisioning, dry-runs each
Worker, deploys public/admin separately, applies D1 migrations, disables raw R2
public access, creates Worker Secrets, and prints only public deployment facts.
Private key material is generated in process memory and piped to Wrangler.
On first provisioning it records Cloudflare's non-secret D1 database ID in both
Wrangler environment bindings. Review and commit those config changes together
with the generated public-key file after staging verification.

`verify:staging` performs real HTTPS check-ins, queries the staging installation,
checks first/last server timestamps, creates one disabled and one short-lived
enabled broadcast, verifies Ed25519 delivery, uploads a PNG through admin,
downloads it through public, verifies SHA-256, and confirms the production
installation count did not change (or that production D1 is absent).

Provision production infrastructure only after that marker exists:

```powershell
$env:VAST_RELAY_ACCESS_CONFIRMED = 'YES'
$env:VAST_RELAY_ALLOW_PRODUCTION_PROVISION = 'YES'
npm run deploy:production
```

Production deployment must leave broadcasts disabled/empty and must not publish
a first user-facing message automatically.

## Rollback

Worker code rollback is independent per Worker:

```bash
npx wrangler versions list --env staging --config public/wrangler.jsonc
npx wrangler rollback --env staging --config public/wrangler.jsonc
npx wrangler versions list --env staging --config admin/wrangler.jsonc
npx wrangler rollback --env staging --config admin/wrangler.jsonc
```

For a failed migration, use the D1 backup/time-travel point that Wrangler
captured before apply. The destructive down migration at
`relay/migrations/rollback/0001_initial.down.sql` is for disposable staging/local
resources only; export first and never run it blindly against production. R2
objects are private and immutable, so a Worker rollback does not require bucket
rollback.

## Phase 2 consumption contract

This contract is now implemented by the modules documented in
[VAST_RELAY_CLIENT.md](VAST_RELAY_CLIENT.md).

Phase 2 should generate and persist one random installation UUID locally,
increment a local launch counter, and perform check-in asynchronously after Vast
is already usable. It must use a short timeout/backoff and ignore all transport,
JSON, protocol, signature, schema, time-window, SemVer, and media failures.

Before rendering a message, Phase 2 must:

1. select the pinned public key by `key_id`;
2. exact-schema-validate the payload;
3. canonicalize it by the rules above and verify Ed25519;
4. render title/body/action as native passive UI using the fixed safe-text
   presentation subset above, never HTML;
5. fetch optional media from the controlled asset endpoint;
6. verify media MIME, size, and signed SHA-256 before decoding;
7. treat release data as a warning/link into the existing trusted updater flow,
   never as package execution authority.

The implemented Control Panel consumes this contract without adding client or
message-interaction telemetry. Operational procedures are in
[VAST_RELAY_OPERATIONS.md](VAST_RELAY_OPERATIONS.md).
