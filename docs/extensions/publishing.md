# Publishing to Vast Extensions

## Publisher workflow

1. Sign in with GitHub. The Hub links the stable GitHub numeric user ID to one publisher record; it does not retain the OAuth access token.
2. Create a listing with a unique slug, name, summary, description, approved category, and optional HTTPS homepage/source URL.
3. Build a deterministic `.vext` with a stable `vast.extension_id` matching the listing. A publisher package may be unsigned; an existing signature is never promoted as official trust.
4. Upload from the dashboard. The Worker streams a bounded body to memory, strictly parses the archive, validates identity/version/manifest/resources/permissions/static policy, and writes an expiring R2 staging object.
5. Submit the validated release. The current published release remains available while an update is pending.
6. A different reviewer/admin inspects the queue and automated findings. Reject/request-changes decisions require a note. The publisher cannot self-approve.
7. Approval claims the submission against concurrent reviewers, reloads the R2 staging object, repeats all validation, repackages it with the authoritative publisher identity, signs the canonical metadata with the current Hub Ed25519 key, creates a signed descriptor, stores an immutable content-addressed object, and atomically updates D1 visibility.
8. New releases repeat upload and review and must have a higher semantic version. The desktop update engine auto-activates only same-or-narrower permission snapshots; increased access requires user approval.

The published object layout is:

```text
staging/<extension-id>/<release-id>/<nonce>.vext
packages/<extension-id>/<version>/<sha256>.vext
media/<extension-id>/<random>.(png|jpg|webp)
```

Staging objects have an expiry timestamp and a scheduled Worker deletes abandoned objects. Official package keys are content-addressed and served only when a published D1 release and non-suspended listing reference them.

## Local Hub development

See `extensions-hub/README.md`. Core D1/R2/signing/review tests use the Workers runtime locally and a clearly labeled RFC test key; they require no production Cloudflare or GitHub credentials.
