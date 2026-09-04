# Microsoft Store submission

Vast 0.2.7 has two Windows distribution channels built from the same source:

| Channel | Package | Updates | Identity |
| --- | --- | --- | --- |
| `direct` | NSIS installer, portable EXE, standalone updater | Vast updater | Explicit release signature policy (currently authorized unsigned) |
| `microsoft-store` | Native x64 MSIX | Microsoft Store | Partner Center package identity |

`VAST_DISTRIBUTION_CHANNEL` is embedded at build time. It is local package
metadata only and is never sent to Relay. Public builds in both channels use
production Relay and the production Extensions Hub.

## Production identity

Reserve `Vast Browser` in Partner Center first, then copy the three values
exactly from Product identity. Production packaging fails closed if any value
is absent. The generated package and application display name must remain
exactly `Vast Browser`, matching the Store name reservation:

```powershell
$env:VAST_MSIX_IDENTITY_NAME='<Partner Center Package/Identity/Name>'
$env:VAST_MSIX_PUBLISHER='<Partner Center Package/Identity/Publisher>'
$env:VAST_MSIX_PUBLISHER_DISPLAY_NAME='<verified publisher display name>'
```

Do not guess these values and do not commit them as product defaults. The local
development package uses the visibly separate `VastBrowser.Development`
identity and an ephemeral self-signed certificate.

## Version and architecture

The mapping is centralized in `scripts/store-msix-config.cjs`:

```text
semantic x.y.z -> (x + 1).y.(z + 1).0
0.2.7 -> 1.2.8.0
```

The first part is non-zero, each part fits the MSIX range, and the Store-reserved
fourth part remains zero. The patch offset prevents the corrected 0.2.7 binary
from reusing `1.2.7.0`, which was consumed by the rejected Electron 44.0.0
submission. Confirm in Partner Center that `1.2.8.0` is greater than every
previous package version before producing the final artifact. Vast currently
ships Store packages only for Windows x64.

## Build and verification

For a local package without production identity:

```powershell
npm run test:store
npm run dist:store:dev
$env:VAST_ALLOW_DESTRUCTIVE_STORE_E2E='YES' # isolated test account only
npm run test:store:upgrade
```

For the production submission package, start from the exact clean release SHA:

First, explicitly refresh the reviewed browser baseline, review the generated
`scripts/store-browser-policy.json`, and commit it. Normal local builds do not
scrape a live version endpoint:

```powershell
npm run store:policy:refresh
git diff -- scripts/store-browser-policy.json
```

Then build from the resulting exact clean release SHA:

```powershell
$env:VAST_RELEASE_CHANNEL='stable'
$env:VAST_DISTRIBUTION_CHANNEL='microsoft-store'
$env:VAST_PRIVATE_BUILD='0'
$env:VAST_UPDATE_ENABLED='0'
$env:VAST_OBFUSCATE='1'
$env:VAST_RELAY_ENABLED='1'
$env:VAST_RELAY_ENVIRONMENT='production'
$env:VAST_RELEASE_COMMIT=(git rev-parse HEAD)
npm run release:store:check
npm run dist:store
npm run store:wack -- -PackagePath release/store/Vast-0.2.7-Store-x64.msix
```

The build uses the x64 Windows SDK `MakeAppx.exe`, not an NSIS wrapper. The
package verifier unpacks the resulting MSIX, validates manifest identity,
version, architecture, assets, hardened Electron runtime, production service
metadata and the absence of direct updater files or secret material.

The production MSIX is intentionally submitted unsigned because Microsoft
Store signs the package after certification. The final verifier still unpacks
it and inventories every actual PE by header regardless of filename or
extension, but that inventory is security/provenance evidence rather than an
extra certificate requirement. Direct/sideloaded packages have a different
trust model and are not covered by the Store signature.

WACK is a real gate. `scripts/run-windows-app-certification.ps1` returns
`BLOCKED` if the current Windows App Certification Kit is unavailable and fails
unless its generated report says PASS.

## Runtime behavior

- Store updates: the direct updater is disabled and Settings reports “Updates
  are managed by Microsoft Store.”
- Profile: installed direct and Store builds both use `%APPDATA%\Vast`, so
  settings, sessions, extensions, Relay identity and the encrypted password
  vault survive a channel change and an MSIX upgrade. Store uninstall preserves
  this user-created profile.
- Portable: the portable EXE uses `Vast Data` beside the executable and never
  joins the installed profile.
- Package files: the MSIX installation directory is treated as immutable.
  Avidae writes to the Vast profile, disables Python bytecode writes, and uses
  bundled read-only Python, FFmpeg and Playwright Chromium paths.
- Defaults: Store packages declare `vast`, `http` and `https` handlers in the
  manifest and open Windows Default Apps. They do not write the unpackaged
  StartMenuInternet registration. Direct uninstall still removes only
  Vast-owned registry state and never deletes generic protocol or UserChoice
  keys.
- Side by side: direct and Store installs share one profile and single-instance
  behavior. Do not run both channels concurrently during migration testing.

## Store listing and certification notes

The listing and certification notes must disclose, consistently with Settings
and `docs/PRIVACY.md`:

- Vast is an Electron/Chromium browser and the submitted runtime version;
- Vast is local-first and sends no browsing history, URLs, searches, tabs,
  bookmarks, passwords or page content to Relay;
- production Relay receives only its documented bounded operational check-in;
- Video & Audio is a local optional tool using bundled Python, FFmpeg and
  Playwright Chromium;
- links: `https://vastbrowser.com/privacy` and
  `https://vastbrowser.com/support`;
- any external-service behavior used by a feature.

Use only a private support/privacy contact already verified in Partner Center
or on the production site. Do not invent an email address. Historical website
copy may describe old 0.2.5 artifacts as unsigned; once a newly signed download
is truly current, current-download copy must not call it unsigned.

Do not submit until `docs/RELEASE_0.2.7_READINESS.md` is fully PASS and the
one-time infrastructure prerequisites are COMPLETE.

## Partner Center owner checklist

### A. Account, product and identity

- [ ] Confirm the Microsoft Partner Center developer account is active and its
  legal publisher verification is complete.
- [ ] Create a new MSIX/PWA product and reserve the intended Vast product name.
- [ ] In Product management > Product identity, copy the exact Package/Identity
  Name and Publisher. Copy the verified publisher display name; do not derive
  or normalize any of these values.
- [ ] Store them in the protected `public-release` GitHub environment as
  `VAST_MSIX_IDENTITY_NAME`, `VAST_MSIX_PUBLISHER`, and
  `VAST_MSIX_PUBLISHER_DISPLAY_NAME`. Do not commit them as defaults.
- [ ] Confirm the Store package history makes `1.2.8.0` a strictly newer
  version. If it does not, change the centralized mapping and its tests before
  building; never edit only the manifest.

### B. Pricing and availability

- [ ] Select price and markets using the owner's actual commercial decision.
  This repository does not assume free or paid distribution.
- [ ] Review organizational/market restrictions and the intended release date
  before submission.

### C. Properties

- [ ] Select the closest factual browser/productivity category offered by the
  current Partner Center UI; do not choose a category solely for discovery.
- [ ] Declare Windows desktop x64 and the package's actual minimum Windows
  version.
- [ ] Review `internetClient` and restricted `runFullTrust`. Certification notes
  must explain that Vast is a packaged Electron/Win32 browser and that
  full-trust desktop execution is required for the Chromium host and optional
  local child runtimes. No administrator elevation is requested for normal use.
- [ ] Disclose extension support accurately. Vast only installs packages that
  pass its existing Hub signature, hash, archive, permission and code-policy
  checks.

### D. Age ratings

- [ ] Complete the current questionnaire factually for a general-purpose web
  browser. Do not copy a guessed rating into the submission.
- [ ] Account for user-accessible web content and optional extensions exactly as
  the questionnaire asks; Vast itself does not provide an editorial content
  catalog.

### E-G. Privacy, website and support

- [ ] Privacy policy: `https://vastbrowser.com/privacy`.
- [ ] Website: `https://vastbrowser.com`.
- [ ] Support: `https://vastbrowser.com/support`.
- [ ] Confirm all three production pages load without authentication immediately
  before submission.
- [ ] Add a private support/privacy contact only if one is already verified in
  Partner Center or on the production site. Never invent or publish an address
  for this checklist.

### H. Package

- [ ] From the exact clean reviewed SHA, run the production commands above or
  dispatch `.github/workflows/store-release.yml` with version `0.2.7`.
- [ ] Require artifact `release/store/Vast-0.2.7-Store-x64.msix`, semantic
  version `0.2.7`, identity version `1.2.8.0`, architecture `x64`, and the exact
  reserved identity.
- [ ] Record SHA-256, byte size, source SHA, manifest snapshot, package verifier
  output, browser-recency report and WACK report.
- [ ] Upload the unsigned submission MSIX only after the local content verifier
  passes. Microsoft Store provides the publication signature; an ephemeral
  local development certificate is never a production signer.

### I. Listing

Suggested factual short description for owner review:

> A local-first Windows browser built on Chromium, with workspaces, privacy
> controls and a reviewed extensions system.

The full description should cover only shipping behavior: browsing and tabs,
workspaces, local-first data storage, privacy controls, Password Manager,
signed Extensions Hub packages, and optional Video & Audio/Labs features. It
must not promise unavailable synchronization, anonymity, certification or
Chromium feature parity.

- [ ] Use the final Vast product name and current 0.2.7 screenshots.
- [ ] Capture clean light/dark UI screenshots at dimensions currently required
  by Partner Center; include the main browser, Settings/privacy controls,
  workspaces and optional extensions UI where useful.
- [ ] Upload only Vast-owned icons/marketing art. Confirm transparency, padding,
  readable text, localization and no third-party copyrighted page content.
- [ ] Keep keywords factual and within the limits shown by Partner Center.
- [ ] Do not call the package stable, signed or Store-available until those
  statements are true. Preserve historical unsigned wording for old releases.

### J. Certification notes

Provide reviewers this concise architecture disclosure and update paths if the
UI changes:

> Vast is an x64 packaged Electron/Chromium desktop browser. Normal browsing
> needs no Vast account. Browser data is local by default. The optional signed
> Relay performs the bounded operational check-in described by the privacy
> policy and is not startup-critical. Extensions come from Vast Extensions Hub
> and remain subject to VEXT Ed25519 signature, SHA-256, archive/path/size,
> permission and dynamic-code policy checks. Settings > Labs exposes optional
> local programs. Video & Audio starts an authenticated loopback-only service
> using bundled Python, FFmpeg/FFprobe and Playwright Chromium; it does not need
> administrator rights and keeps mutable data outside the package directory.

- [ ] Add exact steps for any feature the reviewer must enable, plus a safe
  non-sensitive test input. Never include keys, tokens or personal accounts.
- [ ] State that HTTP/HTTPS default-browser changes require explicit selection
  in Windows Default Apps and are never forced.

### K. WACK

- [ ] Open an elevated PowerShell on a clean Windows 11 x64 test machine with
  the current Windows SDK App Certification Kit installed.
- [ ] Run:

```powershell
npm run store:wack -- -PackagePath release/store/Vast-0.2.7-Store-x64.msix
```

- [ ] Require exit code zero and a parsed PASS. Archive
  `release/store/wack-report.xml` with the candidate evidence.
- [ ] Investigate every failure against the actual package. Do not edit the
  parser or downgrade WACK to a warning to make a candidate green.

### L. Submission and failure handling

- [ ] Upload the exact verified MSIX and complete packages, properties, age
  ratings, availability, privacy, support, listing and certification notes.
- [ ] Review the submission summary for identity/version/capability drift, then
  submit manually. The repository intentionally has no automatic Partner Center
  publication step.
- [ ] If certification fails, archive the full report, reproduce locally, fix
  source or packaging, increment the Store package identity version if Partner
  Center consumed it, rebuild from a new clean SHA and rerun every affected
  gate. Never replace evidence beneath an existing SHA.

### M. After publication

- [ ] Verify the Store-delivered package has a Valid Microsoft signature and the
  expected Package Family Name/version.
- [ ] Install from the public Store listing on a clean standard-user Windows 11
  machine, then test launch, browsing, `vast://`, HTTP/HTTPS selection, Relay,
  Hub, extensions, Password Manager, Avidae, restart and uninstall.
- [ ] Verify Store-managed update behavior with the next test submission; the
  direct updater must remain disabled and absent.
- [ ] Confirm user-created `%APPDATA%\Vast` data follows the documented
  preservation policy and no Vast-owned package/registration orphan remains.
- [ ] Record the public Store listing URL and final Store-delivered artifact
  evidence. Only then update website current-download/signing claims.
