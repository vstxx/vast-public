# Extension security model

The extension platform uses independent boundaries so that one metadata field or compromised service record cannot grant a capability.

## Trust boundaries

Vast trusts its own compiled code, its local registry/state only after schema and manifest revalidation, and the current/next Ed25519 public keys embedded in the executable. For Hub installs it verifies both the signed release descriptor and the `.vext` signature, then checks the downloaded SHA-256 and every package file hash. The Hub private signing key is a deployment secret and is never part of the desktop app or repository.

Vast does not trust the Hub transport alone, catalog JSON, D1 rows, R2 object names/content, deep-link parameters, package paths, manifest claims, renderer IPC payloads, extension-provided IDs, or previously extracted files.

## Runtime boundaries

- Chrome extensions load only into persistent normal workspace sessions. Electron's extension support is narrower than desktop Chrome and must be tested explicitly.
- Native background, sidebar, popup, and options surfaces use isolated, in-memory Chromium partitions, `sandbox: true`, `contextIsolation: true`, Node integration disabled, popups denied, and navigation restricted to the extension resource origin.
- Chrome popup/options surfaces require a one-time main-process attachment token, an enabled installed extension, an eligible persistent workspace, an exact verified local page, and same-extension-origin navigation.
- `vast-extension://` serves only validated files from the owning managed/unpacked root with containment and MIME checks.
- The dedicated preload exposes typed `vast.*` methods, not generic IPC. Main authenticates `webContents` ownership for every message.
- Extension tab APIs exclude private, internal, and non-HTTP(S) tabs. Ephemeral/private partitions never receive extension runtimes.

## Package and update threats

The parser is designed to fail closed against traversal, Windows path quirks, duplicate/case-colliding names, symlinks, special/native executable files, ZIP bombs, malformed headers, size tricks, hash/signature substitution, unknown signing keys, and identity/version disagreement. Extraction uses only the parser's verified file map.

Updates bind the same extension and publisher identities, require a strictly higher semantic version, and preserve the old active version until the candidate starts successfully. New permissions cannot auto-activate. Failed runtime activation restores the old record/runtime and records the failed candidate.

## Hub controls

GitHub OAuth state is random, hashed at rest, cookie-bound, expiring, and single-use. Access tokens are used only to retrieve the stable GitHub user ID and are not persisted. Sessions are opaque and hashed in D1; cookies are Secure, HttpOnly, SameSite where applicable. Mutations require an exact allowed Origin (when supplied), session, and separate CSRF token. Ownership and reviewer/admin roles are checked server-side, and publishers cannot approve their own releases.

All D1 values are parameterized. Inputs and responses are bounded. Public/package abuse controls store an HMAC-derived IP subject instead of the raw address. Security headers include a deny-by-default CSP, `nosniff`, frame denial, restrictive Permissions Policy, and no-referrer. Public HTML escapes all untrusted values and uses no raw publisher HTML.

Review reduces risk but is not a sandbox replacement. Vast still verifies and constrains the artifact on every install/update/startup boundary.
