# Relay public keys

`deploy.mjs` writes one non-secret JSON document per provisioned Ed25519 key.
Commit those public-key documents after verifying the corresponding Worker
Secret was created. Private key material is generated in memory (or supplied by
the operator's secret manager), piped directly to Wrangler, and never written
here.

Key IDs are environment-separated:

- staging: `relay-staging-2026-01`
- production: `relay-2026-01`

Never reuse a key ID for different public key bytes. Rotation adds a new key ID,
keeps the old public key available to clients for the overlap window, switches
the admin Worker's `RELAY_KEY_ID`, and then retires the old key only after old
signed payloads have expired.
