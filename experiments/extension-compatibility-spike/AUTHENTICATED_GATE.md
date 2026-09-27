# Authenticated password-manager gate

The former shared HTTP gate is retired. Its profile remains untouched at:

```text
.vast-build/extension-auth-gate/profile/
```

That profile is historical evidence only. It cannot produce an isolated
Bitwarden, Proton Pass, or combined acceptance result and must not be copied
over any new profile.

Use the trusted-HTTPS gate documented in
[`../password-manager-gate/README.md`](../password-manager-gate/README.md).
Begin with:

```powershell
npm run extension:compat:password-gate -- prepare bitwarden --dry-run
```

The compatibility wrapper requires an explicit target and performs only the
new preflight:

```powershell
npm run extension:compat:auth-gate -- --mode bitwarden --dry-run
```
