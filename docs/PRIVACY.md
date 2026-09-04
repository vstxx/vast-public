# Vast privacy model

Vast collects no browsing telemetry.

When Vast Relay is enabled, its only operational telemetry is:

- a random, persistent installation UUID;
- the running Vast version;
- a cumulative application launch count;
- `instance_kind`: `packaged`, `development`, `test`, or `unknown` for legacy clients.

The Relay service derives first-seen and last-seen timestamps. This minimal,
pseudonymous registry is used for signed service messages, update notices, and
simple anonymous aggregate installation counts. A random installation UUID is
pseudonymous rather than a hardware identity: it is not derived from the
machine, account, Windows identity, hostname, MAC address, or licensing data.
Removing Vast application state and reinstalling may create a new UUID.

Vast Relay does not transmit browsing history, visited URLs, searches, tabs,
bookmarks, session duration, page activity, device fingerprints, account
identity, IP fields, or message read/click/dismiss events. Request-source IPs
may be processed ephemerally by Cloudflare for transport security and rate
limiting, but Vast does not persist them in Relay D1 or pair them with install
IDs in an application analytics store.

Relay test cleanup is allowed only for records whose stored `instance_kind` is
exactly `test`. Cleanup must never infer test status from an ID, age, version,
launch count, or other heuristic.

## Extensions Hub

The Extensions Hub is a separate publisher and distribution service. It
processes GitHub OAuth identity/profile data, session and CSRF records, ephemeral
hashed request keys in Cloudflare native rate limiting, D1/R2 listings, packages and media,
automated and human review records, audit events, versioned Publisher Terms
acceptances, and public abuse/IP reports. Packages and evidence may be retained
for distribution, update continuity, security response, disputes, recovery,
and legal compliance.

Production Workers disable persistent per-invocation logs, sample sanitized
operational/error telemetry, and enable Cloudflare query-string redaction so
OAuth callback parameters are not retained in platform logs. Rate-limit keys
are not stored in Hub D1.

The Hub does not receive browsing history from Vast Browser. Independently
published extensions have their own declared data practices. An extension that
transmits data or uses external processing must name its remote services and
provide an HTTPS publisher privacy-policy URL; local-only extensions explicitly
declare that no such processing occurs.

Browser data and Relay message state otherwise remain local as documented in
[VAST_RELAY_CLIENT.md](VAST_RELAY_CLIENT.md) and
[DATA_MIGRATION_AND_STORAGE.md](DATA_MIGRATION_AND_STORAGE.md).
