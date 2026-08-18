# Vast privacy model

Vast collects no browsing telemetry.

When Vast Relay is enabled, its only operational telemetry is:

- a random, persistent installation UUID;
- the running Vast version;
- a cumulative application launch count.

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

Browser data and Relay message state otherwise remain local as documented in
[VAST_RELAY_CLIENT.md](VAST_RELAY_CLIENT.md) and
[DATA_MIGRATION_AND_STORAGE.md](DATA_MIGRATION_AND_STORAGE.md).
