# `.vext` package specification

`.vext` format version 1 is a deterministic ZIP container. Paths use UTF-8 and `/`. Directory records are not permitted.

## Layout

```text
manifest.json
<extension files, sorted by path>
META-INF/vast-package.json
META-INF/vast-signature.json      # official packages only
```

`vast-package.json` is canonical JSON with recursively sorted object keys and no insignificant whitespace:

```json
{
  "extension_id": "abcdefghijklmnopabcdefghijklmnop",
  "files": [{ "path": "manifest.json", "sha256": "…", "size": 123 }],
  "format_version": 1,
  "manifest_sha256": "…",
  "publisher_id": null,
  "version": "1.0.0"
}
```

Files are sorted, unique under exact and case-folded comparison, and individually SHA-256 hashed. `vast-signature.json` records signature version 1, algorithm `Ed25519`, the signing key ID, and a base64 signature over the canonical metadata bytes. Hub descriptors are independently Ed25519-signed and bind extension ID, publisher ID, version, package URL, SHA-256, key ID, permissions, and publication time.

## Hard limits

| Limit | Value |
| --- | ---: |
| Compressed package | 20 MB |
| Total expanded files | 40 MB |
| One file | 15 MB |
| Extension files | 2,000 |
| UTF-8 path | 512 bytes |
| Large-file compression ratio | 200:1 |

The parser rejects ZIP64/multi-disk/encryption/data descriptors/unknown flags, unsupported methods, malformed or overlapping records, trailing central data, traversal, absolute/drive/URI/backslash/control paths, Windows reserved names, case collisions, symlinks/special files, native/shell executables, and nested archives. It validates local and central records, output size, CRC-32, the metadata inventory, every SHA-256, manifest identity, version, and signature.

## Managed activation

Parsing occurs before extraction. Validated bytes are written with create-new semantics under `Extensions/Staging`, then the content directory is renamed into an immutable version directory. Registry/state activation happens only after runtime validation. The prior version remains available for rollback; stale versions and abandoned staging data are cleaned. Same-version/different-hash replacement is rejected.

The pack command is deterministic:

```powershell
npm run extension:pack -- .\extension --out .\release\extension.vext
```

Local packages are intentionally labeled **Local** and may be unsigned. Hub packages must verify under a public key pinned in the Vast executable.
