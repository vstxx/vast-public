# Vast Extensions Hub

Cloudflare Worker for the publisher-oriented Vast Publisher Platform, public catalog, publisher dashboard, role-aware review queue, official package signing, and immutable package/media delivery.

## Catalog synchronization model

The published D1 catalog is the only source of truth for Explore. The public website and Vast Browser read the same published extension/current-release rows; Vast only overlays the current profile's local `installed` state. Catalog, details, and current-release metadata use `Cache-Control: no-store`, and the browser revalidates Explore when it is opened or regains focus.

Draft, pending, rejected, suspended, and release-less listings appear in neither client. Installing an unpacked or local package does not publish it: publishing always requires an authenticated publisher upload and a review decision, so private code and profile state never leave the device implicitly. Reviewers cannot approve their own releases. A trusted `admin` may self-approve as an explicit operational override; that path still revalidates and signs the package and records `admin-self-approve-and-sign` in the audit log.

## Bindings

- `DB`: D1 database (`vast-extensions-hub`), migrations in `migrations/`.
- `PACKAGES`: R2 bucket for `staging/`, `packages/`, and `media/` objects.
- `ASSETS`: static `public/` binding.
- Plain vars: `ENVIRONMENT`, `HUB_ORIGIN`, `GITHUB_REDIRECT_URI`, `SIGNING_KEY_ID`.
- Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `HUB_SIGNING_PRIVATE_KEY_PKCS8`, `HUB_RATE_LIMIT_SECRET`.

The signing secret is base64 PKCS#8 for the Ed25519 public key pinned in the matching Vast build. Provision it through an audited key ceremony; never paste it into `wrangler.jsonc`, `.dev.vars`, logs, source, or issue trackers.

## Local verification

From the repository root:

```powershell
npm run hub:types
npm run hub:typecheck
npm run hub:test
npm run hub:build
```

`hub:test` runs locally in workerd with local D1/R2 and an explicitly test-only RFC key fixture. For interactive development, create an uncommitted `extensions-hub/.dev.vars` containing development-only secret values, then run `npm run dev --prefix extensions-hub`. `.dev.vars*` is ignored by Git.

Apply local migrations with:

```powershell
npx wrangler d1 migrations apply vast-extensions-hub --local --config extensions-hub/wrangler.jsonc
```

## Production preparation

Create/confirm the D1 and R2 resources for the Cloudflare account and add the secret bindings without printing their values:

```powershell
npx wrangler secret put GITHUB_CLIENT_ID --config extensions-hub/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET --config extensions-hub/wrangler.jsonc
npx wrangler secret put HUB_SIGNING_PRIVATE_KEY_PKCS8 --config extensions-hub/wrangler.jsonc
npx wrangler secret put HUB_RATE_LIMIT_SECRET --config extensions-hub/wrangler.jsonc
npx wrangler d1 migrations apply vast-extensions-hub --remote --config extensions-hub/wrangler.jsonc
```

Before deployment, replace/confirm the compiled desktop public key and `SIGNING_KEY_ID`, configure the exact GitHub OAuth callback, add an R2 lifecycle rule as defense in depth for `staging/`, run all repository release gates, and perform a two-person signing/key-rotation review. An administrator's release self-approval does not replace the two-person procedure for signing-key changes. Deployment command (only when explicitly authorized):

```powershell
npx wrangler deploy --config extensions-hub/wrangler.jsonc
```

The repository's automated command is deliberately a dry-run build; it does not deploy production.

## Operational safety

Suspend a compromised listing through the reviewer API; suspended listings, descriptors, packages, and media stop being publicly served. A publisher may yank only a non-current release. Audit entries contain actor/action/target/note but no tokens, package bodies, IP addresses, or signing material. The scheduled handler removes expired OAuth/session/rate-limit/review-claim state and abandoned staging objects.
