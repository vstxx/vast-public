# Authenticated HTTPS / autofill gate

This local-only harness validates unmodified Bitwarden and Proton Pass against
trusted HTTPS fixtures. It uses three independent persistent profiles and
never reads or records vault contents or credential values.

## Fixed order and paths

Run the modes in this order:

1. `bitwarden`
2. `proton`
3. `combined`

The second gate is blocked until the first has passed (or has an explicitly
accepted class-A limitation). The combined gate is blocked until both isolated
gates pass.

Persistent profiles are never deleted by ordinary gate commands:

```text
.vast-build/password-manager-gates/profiles/bitwarden/
.vast-build/password-manager-gates/profiles/proton/
.vast-build/password-manager-gates/profiles/combined/
```

The retired shared profile remains separately preserved at
`.vast-build/extension-auth-gate/profile/`. Never copy it into an isolated
profile.

## Prerequisites

- Patched Electron 44.3.0 at `VAST_PATCHED_ELECTRON_DIST` (default
  `D:\VastElectron44\src\out\VastCompat`).
- The matching executable may be selected with
  `VAST_PATCHED_ELECTRON_EXE`; it must remain inside that distribution.
- Official CRX3 packages. Defaults are `extension-reference/bitwarden.crx`
  and `extension-reference/protonpass.crx`. Override them only with absolute
  paths in `VAST_BITWARDEN_CRX` and `VAST_PROTON_PASS_CRX`.
- Prepared ECE 4.9.0 compatibility changes. Check them with
  `npm run extension:compat:check`.
- Existing Vast output at `out/main/main.js`. A gate never builds it unless
  `--build-vast` is explicitly passed.

The harness derives the official extension ID from each CRX public key and
adds only that verified `manifest.key` to an ignored disposable runtime copy.
It never edits `extension-reference/` or another third-party source tree.

## Trusted local TLS

Install or validate the dedicated current-user test CA and leaf certificate:

```powershell
npm run extension:compat:password-gate -- tls-setup
```

The certificate covers exactly:

- `login.vast-test.local`
- `spa.vast-test.local`
- `dynamic.vast-test.local`
- `iframe.vast-test.local`

The browser process maps those names to `127.0.0.1`. The gate does not edit the
hosts file and never uses certificate-error, disabled-web-security, or TLS
bypass switches.

Remove only the fingerprint-bound certificates recorded by the harness:

```powershell
npm run extension:compat:password-gate -- tls-remove
```

Private PFX/passphrase files remain ignored unless the cleanup script is
explicitly run with its `-RemoveFiles` option.

## Controlled credential hashes

Use a dedicated test account and a non-production fixture credential. The
fixture needs SHA-256 hashes to verify a fill without storing the values. From
an interactive terminal, capture them through the non-echoing prompt (replace
the mode in both paths as needed):

```powershell
node -e "const p=require('node:path');const {CheckpointStore}=require('./scripts/password-manager-gate/checkpoints.cjs');new CheckpointStore({checkpointPath:p.resolve('.vast-build/password-manager-gates/credential-hashes/bitwarden-unused.jsonl'),credentialHashPath:p.resolve('.vast-build/password-manager-gates/credential-hashes/bitwarden.json')}).captureCredentialHashes().then(()=>console.log('Credential hashes stored.'))"
```

Alternatively provide both `VAST_GATE_USERNAME_SHA256` and
`VAST_GATE_PASSWORD_SHA256`, or point `VAST_GATE_CREDENTIAL_HASH_FILE` at an
absolute JSON file with `usernameSha256` and `passwordSha256`. Do not place
plaintext credentials, tokens, cookies, authorization URLs, or vault data in
environment variables, commands, reports, screenshots, or chat.

If the stored hashes might not match the isolated vault item, create a fresh
controlled test pair instead of accepting a mismatched fill:

```powershell
powershell -STA -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/create-test-credential.ps1 -Mode bitwarden
```

The visible window generates a new pair in memory. Copy it into a dedicated
item in the **isolated Bitwarden test profile**. Set the item's Website (URI)
to `https://login.vast-test.local/` with **Host** match detection: Bitwarden's
default Base domain matching does not support local TLDs, while Host can match
the same host without specifying the run's changing port. The URI without a
port is a matching label, not a working fixture address or Launch target. Open
the fixture using the exact `https://login.vast-test.local:<current-port>/login`
URL reported by the running gate, then confirm in the window. The script
creates a unique `bitwarden-candidate-*.json` containing only hashes and
prints its path; it does not replace `bitwarden.json`. A later gate run can use
that exact candidate by setting `VAST_GATE_CREDENTIAL_HASH_FILE` to its
absolute path before starting the background wrapper. A matching fill must
still be observed; creating the candidate is not gate evidence. The window
clears the clipboard on close if it still holds one of the generated values.
The new run stores only a SHA-256 fingerprint of the credential-hash pair in
its command/result metadata and refuses to resume with a different reference.

## Preflight and start

Preflight does not modify a profile:

```powershell
npm run extension:compat:password-gate -- prepare bitwarden --dry-run
```

For a long interactive run, use the background wrapper. Electron stays
visible while the controller window is hidden:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/start-background.ps1 -Mode bitwarden
```

Before starting or resuming anything, inspect the previous process and its
artifacts. Never infer completion from elapsed time or an ETA:

```powershell
$meta = Get-Content -Raw .vast-build/password-manager-gates/background/bitwarden/launcher.json | ConvertFrom-Json
Get-Process -Id $meta.controllerPid -ErrorAction SilentlyContinue
Get-Content $meta.status
Get-Content $meta.exitCode -ErrorAction SilentlyContinue
Get-Content $meta.log -Tail 80
Get-Content $meta.errorLog -Tail 80
```

The wrapper refuses a live launcher or profile lock. A dead lock may be
recovered without deleting profile data. `resume` reuses the selected run ID,
profile, and exact fingerprint; it refuses runtime drift:

```powershell
npm run extension:compat:password-gate -- status bitwarden
npm run extension:compat:password-gate -- resume bitwarden --run-id <run-id>
npm run extension:compat:password-gate -- stop bitwarden --run-id <run-id>
```

A running isolated gate can perform a controlled Vast restart without resetting
its profile. The controller requires a graceful Electron exit, checks the exact
runtime fingerprint before relaunch, captures a restart artifact, and resumes
privacy/fixture observation:

```powershell
npm run extension:compat:password-gate -- restart bitwarden --run-id <run-id>
```

`vast-restart` covers only the mechanical restart with the same profile and
runtime. It does **not** prove that vault authentication survived, or that
autofill still works; those remain separate scenarios.

The controller waits for a short Chromium process-quiescence interval after the
old Electron main process exits and before relaunching. This prevents a rapid
test-only restart from overlapping old renderer teardown with the new browser
process; the runtime fingerprint is checked after the wait and before launch.

For read-only field diagnostics, a running isolated Bitwarden gate can scan
the eight approved HTTPS fixtures without entering any credential:

```powershell
node scripts/password-manager-gate/scan-fixtures.cjs <run-id>
```

The scan stores only fixture snapshots (presence/hash-match booleans), field
focus booleans, child-form presence, and whether Bitwarden overlay iframe
targets appeared after clicking each approved form. It reads neither field
values nor vault data. After stopping the run, record a complete 8/8 scan:

```powershell
node scripts/password-manager-gate/scan-fixtures.cjs <run-id> --record
```

This passes only `content-script` and `field-detection`. A missing overlay is
diagnostic until reproduced with a human click and compared against Chrome;
it is not automatically a compatibility defect. The scan does not establish
credential suggestion, autofill, origin isolation, or session persistence.

When that scan reproduces `Receiving end does not exist`, collect safe routing
metadata from the live Bitwarden worker with:

```powershell
node scripts/password-manager-gate/probe-missing-receiver.cjs <run-id>
```

The probe temporarily instruments only `runtime.sendMessage` and
`tabs.sendMessage` through CDP. It records the API name, upstream extension ID,
sender/receiver context, integer tab/frame IDs, timing buckets, counts, and the
8/8 fixture result. Because debugger pauses can perturb overlay timing, that
acceptance scan runs only after the original API functions are restored and the
debugger is disabled. It never evaluates, stores, or prints a message payload.
The generated evidence intentionally remains `unclassified`: a correlation is
not proof that teardown preceded the send, and it does not by itself justify a
Vast, ECE, or Electron patch.

While the same run is live, probe a SPA route change without a document reload:

```powershell
node scripts/password-manager-gate/probe-spa-route.cjs <run-id>
```

The probe checks that the document survives, the form element is replaced,
the route changes, and a new Bitwarden overlay appears after a fixture-field
click. It records booleans only and does not count as an autofill pass.

To diagnose Bitwarden MV3 worker sleep/wakeup without reading vault state, a
running isolated gate may probe only Bitwarden's own worker version. The probe
requests a targeted worker stop, reloads the controlled HTTPS fixture, and
checks whether a new worker target appears and whether the three approved
privacy settings remain available:

```powershell
node scripts/password-manager-gate/probe-worker-lifecycle.cjs <run-id>
```

The probe never calls `stopAllWorkers`, reads message payloads, or records
credentials. A synthetic stop/reload is diagnostic; the full natural idle
sleep/wakeup gate remains separate until its behavior is observed.

For a natural idle observation, leave the live isolated gate untouched and run
the bounded 45-second probe:

```powershell
node scripts/password-manager-gate/probe-worker-idle.cjs <run-id>
```

It never invokes `stopWorker`. If the worker disappears on its own, the probe
reloads only the approved fixture and checks for a new worker plus restored
privacy settings. After stopping the run, ordered destroy/create events with
no correlated process crash can be bound to `worker-sleep-wake`:

```powershell
node scripts/password-manager-gate/probe-worker-idle.cjs <run-id> --record
```

This does not prove that vault authentication or autofill survived the wake;
those remain separate gate scenarios.

The following diagnostic invokes the existing Vast extension manager's reload
for the official Bitwarden ID and checks only success, unchanged identity,
enabled state, worker target replacement, and approved privacy settings:

```powershell
node scripts/password-manager-gate/probe-extension-reload.cjs <run-id>
```

It does not inspect the vault or assume that manager reload success proves
authenticated state, content-script reinjection, or autofill after reload.

After all other live-run probes, perform the canary check as the **last**
operation:

```powershell
node scripts/password-manager-gate/probe-secret-canary.cjs <run-id>
```

It navigates one approved fixture with a freshly generated, non-credential
query marker, verifies that the browser actually loaded that URL, returns to
the clean fixture URL, gracefully stops the gate, and scans its artifacts plus
the two process logs for literal/encoded marker variants. The marker stays in
memory; only its SHA-256 and pass/fail metadata are stored. If a leak is
found, the command fails without echoing the marker. It does not inspect
vault data or replace the separate authenticated gate scenarios.

## Checkpoints and evidence

Authentication, vault synchronization, credential selection, save/update
prompts, popup review, and session-persistence observations are manual. A
manual confirmation is not sufficient to pass: every required scenario also
needs machine evidence tied to the same checkpoint. Auto-submit is observed
but is not an acceptance requirement.

After the operator explicitly confirms that Bitwarden or Proton performed a
manual fill, stop that isolated run and record the confirmation against its
already-captured matching fixture artifact:

```powershell
node scripts/password-manager-gate.cjs confirm-autofill bitwarden --run-id <run-id> --operator-confirmed
```

This refuses a live run, mismatched credential reference, missing or changed
fixture artifact, or conflicting checkpoint. It writes an append-only
checkpoint and scenario link; it does not pass credential suggestions, frame
isolation, vault operations, or the whole gate.

For Bitwarden, if the operator also saw and selected the inline credential
suggestion, confirm that separately after stopping the run:

```powershell
node scripts/password-manager-gate.cjs confirm-suggestion bitwarden --run-id <run-id> --operator-confirmed
```

This requires a lifecycle event for the official Bitwarden
`overlay/menu-list.html` iframe within 30 seconds before a matching controlled
fill on the ordinary login fixture. It records only the event sequence,
extension ID, context type, timestamp, and fixture evidence ID. The iframe
event alone is insufficient: explicit operator confirmation is required.
Neither the suggestion text nor vault item contents are read or stored.

The controller records redacted fixture snapshots automatically. One snapshot
with both controlled credential hashes matching and no foreign fill can pass
only `username-hash-match` and `password-hash-match`. It does not prove that an
extension performed autofill, that credentials stayed within the intended
frame, or that a vault operation succeeded; those scenarios stay blocked until
their separate evidence and checkpoints exist. Neither credential value is
stored in a snapshot.

Run artifacts live at `.vast-build/password-manager-gates/runs/<run-id>/`:

```text
command.json
events.jsonl
checkpoints.jsonl
result.json
status.json
launcher.json (only while the controller is live)
```

Events contain only allowlisted lifecycle metadata. Process output is drained,
but only recognized diagnostic classes are persisted; raw lines and message
payloads are discarded. Repeated diagnostics retain the first 16 events per
class/stream/minute and power-of-two occurrence samples thereafter, so a
runaway warning cannot grow the event log without bound. `ProcessCrash` is
recorded only for an explicit Chromium process-crash or fatal-process signature;
generic text containing `crash`, including Crashpad startup and native-host
lifecycle output, is not crash evidence. Verification fails when required
checkpoints or machine evidence are absent, fingerprints differ, a secret scan
is missing, or a class-B defect remains unresolved:

```powershell
npm run extension:compat:password-gate:verify -- bitwarden --run-id <run-id>
```

`Receiving end does not exist` and `Invalid guestInstanceId` are evidence to
classify, not warnings to suppress. Patch only a reproduced class-B defect
with functional loss and an assigned owner. No Electron rebuild is authorized
without that source-level evidence.

An explicitly exploratory later-mode run may bypass an unfinished predecessor
only for bug discovery:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/start-background.ps1 -Mode proton -Exploratory
```

The run and its command metadata are permanently marked `exploratory: true`.
Verification always rejects it, so it cannot satisfy a gate, unlock a combined
acceptance run, or be used as release evidence. Exploratory runs use fixed
non-secret sentinel hashes and record `credentialConfigured: false`; therefore
they can exercise extension loading and APIs but cannot claim credential-match
or autofill acceptance evidence.

For a live exploratory combined run, the coexistence scanner visits only the
eight approved HTTPS fixtures and records structural booleans for both injected
UIs plus whether both official MV3 workers were observed. It tolerates normal
worker sleep between observations and never reads field values, vault data, or
message payloads:

```powershell
node scripts/password-manager-gate/scan-combined-fixtures.cjs <run-id>
```

An unauthenticated or not-yet-configured combined profile is expected to produce
a failed scan even when both workers are healthy. Authenticate both extensions
in that same persistent profile before using the scan as coexistence evidence.

The approved ECE preload patch also removes upstream debug statements that
printed complete extension API argument/result arrays. Known errors are reduced
to fixed text or allowlisted routing metadata; generic failures never print raw
error objects, locations, payloads, or credentials.

## Recovery rules

- Inspect PID, status, log tail, exit code, and existing artifacts first.
- Do not launch a duplicate controller while the recorded PID is alive.
- Do not delete or reset a profile to fix an orchestration problem.
- Do not reuse one mode's profile for another mode.
- Do not run a surprise Vast or Electron build during `resume`.
- If a fingerprint changes, start a new run and retain the old evidence.
- If TLS metadata or a profile lock is malformed, stop and investigate; never
  downgrade to HTTP or a security bypass.
