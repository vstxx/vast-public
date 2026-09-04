# Vast Relay desktop client (Phase 2)

Vast Relay is an optional, fail-soft main-process service for signed Vast
messages and update availability metadata. It never participates in the
critical browser startup path and never authorizes software execution.

## Privacy and local state

The only request body is:

```json
{
  "protocol": 1,
  "install_id": "random UUIDv4",
  "current_version": "0.2.7",
  "launch_count": 1,
  "instance_kind": "packaged"
}
```

`install_id` comes from `crypto.randomUUID()` and is stored with the launch
counter and local dismissal IDs in `vast-relay-state.json` under the active
Vast profile root. It is not derived from a machine, account, license, Windows
identifier, hostname, username, or network address. A profile removal causes a
new identity on the next launch. The count increments once when the singleton
Relay service starts for a genuine application launch—not per window, renderer,
request, retry, or tab. This local state is maintained even in a build whose
Relay network endpoint is disabled, so later activation does not redefine launch
semantics. Corrupt state is replaced with a new random identity.

No URL, history, search, tab, bookmark, extension, session, hardware, account,
or message-read/click/dismiss data is transmitted. Dismissals remain in the
local file, are retained for at most 400 days, deduplicated, and capped at 500.
The backend derives first-seen and last-seen timestamps.

## Lifecycle and failure policy

```text
browser shell usable
       |
       +-- Relay state increments once
       +-- 3 second deferred check-in
       |       `-- 7.5 second request/body timeout
       +-- success: next check-in randomly 5.5–6.5 hours later
       `-- temporary failure: 1m, 5m, 20m retries (±20%), then periodic
```

HTTP 429 honors `Retry-After` clamped to five minutes through six hours. Network,
408, 425, and 5xx failures use the capped retry schedule. Other 4xx, malformed
JSON, unsupported protocol, and invalid schemas wait for the next periodic
check. DNS, connection, timeout, D1-degraded, signature, and asset failures do
not show browser error dialogs and cannot delay window creation or normal Vast
features. Shutdown cancels the timer and aborts an in-flight request.

The service uses a non-persistent `vast-relay` Electron session with caching
disabled. The request has no credentials or referrer. The current version is
always read from `app.getVersion()`.

## Trust pipeline

Remote response data remains in the main process through this pipeline:

```text
bounded HTTPS response
  -> exact protocol/runtime schemas and size limits
  -> canonical payload reconstruction
  -> key_id lookup in compile-time pinned keys
  -> Ed25519 signature verification
  -> enabled/time/SemVer eligibility
  -> local dismissal and deterministic priority queue
  -> passive presentation DTO over narrow IPC
```

Unknown message types, fields, keys, severities, malformed Base64, ambiguous
timestamps, non-HTTPS actions, and invalid signatures disappear. The renderer
receives title/body/type/action label and already-verified image bytes. It never
receives the remote action URL or a generic command. JSX renders strings as
text; no remote HTML, CSS, JavaScript, Electron command, shell command, or Node
code is accepted.

The main process accepts only the currently displayed `presentationId` back for
dismiss or action. Message actions resolve to the previously verified HTTPS URL
and use Vast's normal external-navigation prompt. Update actions first use the
existing `electron-updater` state machine only when it already reports a ready
trusted update. Otherwise they may open an allowlisted Vast/GitHub release page.
A Relay signature is never package-install authority.

## Messages and media

The local UI implements `welcome`, `seasonal`, `announcement`, `security`, and
`update_notice`, plus `optional`, `recommended`, `important`, and `critical`
release notices. It displays one restrained card at a time. Critical releases,
security messages, type weight, signed priority, activation time, and ID produce
a deterministic queue. Reduced-motion preferences disable transitions; remote
GIF media is omitted when reduced motion is requested.

Optional PNG, WEBP, and GIF assets are fetched only through
`/v1/assets/:assetId`, with a 7.5 second timeout and 2 MiB limit. The client
requires the signed MIME, image magic bytes, and signed SHA-256 before passing
bytes to the renderer. Its memory-only cache is capped at eight entries and
8 MiB. Text remains usable if media fails.

## Fixed environments and keys

| Build channel | Endpoint | Default |
|---|---|---|
| public beta / stable | `https://relay.vastbrowser.com` | enabled; release gate requires `VAST_RELAY_ENVIRONMENT=production` |
| development / internal QA | `https://relay-staging.vastbrowser.com` | enabled by default; may explicitly select production for production smoke tests |

Pinned SPKI DER public keys (Base64):

- `relay-staging-2026-01`: `MCowBQYDK2VwAyEAUdjyVaeSUezix+E2jaSJzfoLaVU3x/HH3iXsUyv433k=`
- `relay-2026-01`: `MCowBQYDK2VwAyEAK2ESqwYH5ULmvRoNMGU7SwFF2pnk7yegAyxKUwhplI0=`

Key rotation adds a new immutable `key_id`/public-key entry and retains the old
public key through the maximum lifetime of already signed broadcasts. Private
Relay keys remain only in the admin Worker secret and are unrelated to updater
or Authenticode keys.

## Verification

Run local checks with:

```powershell
npm run lint
npm test
npm run build
```

The Relay tests cover state persistence/counting, request shape/version source,
protocol and URL schemas, canonicalization and Ed25519 tamper cases, activation
and version windows, queue/dismissal behavior, retry/429/timeout/outage paths,
media size/MIME/magic/digest validation, endpoint separation, and updater action
boundaries. Staging verification must use an isolated `VAST_TEST_USER_DATA_DIR`,
then confirm the same ID/count in both the local state and staging D1. Test
broadcasts, releases, assets, and intentionally tampered rows must be removed
afterward. Finally verify production returns `messages: []`, `update: null`, and
that no development installation reached production D1.

The Cloudflare Access protected Control Panel is documented in
[VAST_RELAY_OPERATIONS.md](VAST_RELAY_OPERATIONS.md). It attaches to the admin
Worker without adding client interaction telemetry.
