# Vast Relay

Cloudflare Workers, D1, R2, and the private Vast Control Panel for minimal
installation check-ins, signed structured messages, media, and update notices.

## Local verification

```powershell
npm ci
npm run types
npm run check
```

`npm run check` builds the Control Panel, checks generated Worker bindings,
type-checks both Workers and the browser UI, and runs the Cloudflare runtime
test suite.

## Deployment order

1. Provision the two deny-by-default Access applications from `infra/access`.
2. Copy their non-secret AUD values into the matching environment in
   `admin/wrangler.jsonc` and run `npm run types`.
3. Set `VAST_RELAY_ACCESS_CONFIRMED=YES` and deploy staging.
4. Complete the staging runbook in
   [VAST_RELAY_OPERATIONS.md](../docs/VAST_RELAY_OPERATIONS.md).
5. Deploy production only after the staging marker exists and production
   Access denial has been verified.

The admin Worker secret is:

- `RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64`

Key rotation may temporarily add:

- `RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64`

The private key never enters source, frontend assets, logs, or documentation.
The public Worker has no signing binding. `RELAY_ADMIN_TOKEN` was a Phase 1
bootstrap secret; it has been deleted from both deployed admin Workers and must
remain absent now that Access protects the control plane.

See [VAST_RELAY.md](../docs/VAST_RELAY.md) for protocol details,
[VAST_RELAY_CLIENT.md](../docs/VAST_RELAY_CLIENT.md) for desktop integration,
and [VAST_RELAY_OPERATIONS.md](../docs/VAST_RELAY_OPERATIONS.md) for final
operations and security procedures.
