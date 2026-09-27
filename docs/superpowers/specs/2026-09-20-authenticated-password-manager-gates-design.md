# Authenticated HTTPS and Autofill Gates for Bitwarden and Proton Pass

Date: 2026-09-20

Status: proposed for implementation

Current targets: Bitwarden 2026.8.0 and Proton Pass 1.40.2

Runtime base: Electron 44.3.0, ECE 4.9.0, Vast's accepted Electron/Chromium patchset

## Purpose

Build a deterministic, privacy-preserving acceptance harness that proves unmodified Bitwarden and Proton Pass can authenticate, synchronize, detect fields, fill and save controlled credentials, survive lifecycle transitions, and coexist in Vast without weakening Vast's security policy.

This phase covers three sequential gates:

1. Bitwarden in its own persistent profile.
2. Proton Pass in its own persistent profile.
3. Bitwarden and Proton Pass together in a third persistent profile.

An isolated gate must pass before work starts on the next gate. A popup rendering successfully is not compatibility evidence by itself.

## Fixed project decisions

- Bitwarden and Proton Pass are the current primary compatibility targets.
- Third-party extension code and source packages remain unmodified. For Electron's unpacked-directory loader, the harness may create a disposable runtime copy whose only manifest difference is a verified upstream `key` derived from the official CRX; it changes no code or other resource, is never redistributed as the upstream package, and must produce the expected upstream runtime ID.
- KeePassXC does not block Vast Browser 1.0.0. KeePassXC Native Messaging and iCloud Passwords belong to a later, generic Native Messaging phase.
- WebSocket redirects remain unsupported and fail closed.
- Vast and ECE use the GPL-3.0-only distribution path. Proprietary extension licenses remain independent.
- There is no public extension beta. The path is isolated development, main Vast integration, complete local/internal validation, then production Vast Browser 1.0.0.
- No full Electron rebuild may start without a reproduced defect whose responsible fix requires Electron or Chromium source changes.
- Warnings are evidence to classify, not automatic reasons to patch.

## Scope boundaries

### In scope

- Trusted local HTTPS origins and deterministic login fixtures.
- Isolated, persistent profiles for Bitwarden, Proton Pass and the combined gate.
- Manual account authentication and vault actions using controlled test accounts and credentials.
- Automated navigation, lifecycle control, non-secret assertions and redacted diagnostics.
- Bitwarden missing-receiver investigation.
- Proton external-message and permission flows.
- Popup, service-worker, restart, reload, save/update and autofill workflows.
- Combined-profile isolation and coexistence.
- Classification of `Invalid guestInstanceId` based on reproduction and functional impact.

### Out of scope

- Native Messaging, iCloud Passwords and KeePassXC integration.
- Public rollout or a public extension beta.
- Production enablement of ECE.
- Patching or repacking third-party extensions.
- Automatic submission of credentials.
- Treating auto-submit as an acceptance requirement unless the same extension version differs from Chrome because of Vast.
- Full Electron rebuilds without source-level evidence.

## Gate architecture

The harness is a local-only controller around the accepted patched Electron runtime and Vast's existing development compatibility gate. It does not create a second extension system.

### Controller

A Node controller owns one run at a time. It:

- verifies the patched Electron executable and compatibility manifest before launch;
- selects exactly one named profile: `bitwarden`, `proton` or `combined`;
- starts the HTTPS fixture server and exact host-resolution rules;
- seeds only the extension records required by that profile;
- launches Vast with ECE enabled through the existing development gate;
- records sanitized browser, extension and lifecycle metadata;
- drives deterministic fixture navigation and restart phases;
- waits at explicit operator checkpoints for login, vault sync, fill, save and update actions;
- writes a machine-verifiable result without recording credential values.

Only one controller may own a profile. A profile lock records the controller PID, runtime fingerprint and run ID. A stale lock may be cleared only after proving the recorded process no longer exists.

### Persistent profiles

Profiles live under the ignored build tree:

```text
.vast-build/password-manager-gates/
  profiles/
    bitwarden/
    proton/
    combined/
  runs/
  tls/
```

The controller never deletes a profile as part of an ordinary run. Destructive reset is a separate, explicit command that names one exact profile and first produces a backup manifest. Bitwarden and Proton isolated gates never share profile data. The combined gate starts from its own profile rather than copying either isolated profile.

### Trusted local HTTPS

The fixture uses these origins:

- `https://login.vast-test.local:<port>`
- `https://spa.vast-test.local:<port>`
- `https://dynamic.vast-test.local:<port>`
- `https://iframe.vast-test.local:<port>`

Windows setup creates a dedicated test root and leaf certificate with SAN entries for exactly those hosts. The root is installed only in the current user's trust store. The root fingerprint, leaf fingerprint, SAN list and expiry are recorded; private keys and PFX passphrases remain ignored and are never logged or committed. Teardown removes only the exact recorded test root after verifying its fingerprint.

The gate process uses exact Chromium host-resolver rules mapping the four names to `127.0.0.1`, avoiding an administrator-level hosts-file edit. It must not use `--ignore-certificate-errors`, a permissive `certificate-error` handler, disabled web security, or a global TLS bypass. Before extension testing, a TLS preflight proves:

- all four names resolve to loopback inside the gate process;
- the certificate chain is trusted normally;
- hostname validation succeeds;
- an unlisted hostname fails;
- Vast emits no certificate exception.

If Windows tooling cannot create or trust the certificate safely, the gate stops with setup instructions. It does not silently downgrade to HTTP or ignored TLS errors.

### Fixtures

The server provides deterministic pages with stable element IDs and a non-secret observation API:

- ordinary username/password login form;
- SPA route changes without document reload;
- form inserted dynamically;
- delayed DOM insertion;
- same-origin iframe;
- cross-origin iframe;
- nested iframe;
- dynamically created iframe;
- credential-save form;
- credential-update form.

Each origin has a distinct fixture identity. Cross-origin and nested cases expose only boolean results such as `usernameFilled`, `passwordFilled`, `unexpectedForeignFill` and `formSubmitted`. Fixture diagnostics never serialize field values.

Controlled test credentials are used only with dedicated test accounts. Expected values enter the controller through a non-echoing operator prompt or an explicitly named secret source. The result files store hashes or booleans, never the values. The fixture does not submit filled credentials to the server for autofill verification. Credential save/update submission is confined to the local server, which discards the body and records only field presence and the expected-value comparison result.

### Operator checkpoints

Authentication and vault UI remain manual because automating real account secrets would create unnecessary exposure. The controller presents numbered checkpoints and resumes only when the operator confirms the visible outcome. Examples:

- account authenticated;
- test vault synchronized;
- controlled credential selected from the extension UI;
- save prompt accepted;
- update prompt accepted.

Automated evidence must independently confirm all observable non-secret effects after each checkpoint. Operator confirmation alone cannot pass a gate.

### Diagnostics and redaction

Every run writes:

```text
runs/<run-id>/command.json
runs/<run-id>/events.jsonl
runs/<run-id>/checkpoints.jsonl
runs/<run-id>/result.json
runs/<run-id>/process.log
runs/<run-id>/status
```

Diagnostics may contain:

- timestamp and monotonic sequence number;
- extension ID and version;
- context type: service worker, popup, tab, frame or extension page;
- tab ID, frame ID and parent frame ID;
- sanitized origin and pathname;
- worker start, stop, wake and listener-registration state;
- message direction and routing outcome;
- webContents creation, attachment, detachment and destruction ordering;
- process exit code and crash metadata.

Diagnostics must not contain:

- message payloads;
- usernames, passwords or vault items;
- cookies, tokens or authorization headers;
- query strings from authentication callbacks;
- page HTML from account or vault pages;
- screenshots of authenticated third-party surfaces;
- signing keys, API credentials or infrastructure secrets.

The recorder sanitizes before writing. Redaction tests use canary secrets and fail if any canary reaches an artifact.

## Gate 1: Bitwarden isolated

The Bitwarden gate uses only the Bitwarden extension and the persistent `bitwarden` profile. It must demonstrate:

- successful login to the controlled Bitwarden account;
- vault synchronization;
- field detection on every fixture class;
- credential suggestion and manual autofill;
- correct username/password placement;
- no fill into a different origin or unauthorized frame;
- credential save and subsequent refill;
- credential update and subsequent refill with the updated value;
- popup workflow;
- service-worker sleep and wake without lost required behavior;
- extension reload;
- Vast restart;
- authentication and vault-session persistence appropriate to Bitwarden's own policy.

### Missing receiver investigation

`Could not establish connection. Receiving end does not exist` is reproduced without suppression. Instrumentation records only routing metadata: sender and receiver context, extension ID, tab/frame identity, worker state, and timestamp/order.

The result is classified as:

- **A: harmless teardown/lifecycle race** — it occurs only around destruction or navigation, the intended recipient no longer exists, and no required user operation is lost; or
- **B: compatibility/message-delivery defect** — a live expected recipient exists or a required operation is observably lost.

Chrome with the identical Bitwarden version and fixtures is the behavioral baseline where practical. Matching harmless Chrome behavior is not a Vast defect.

Before any patch, ownership must be assigned using evidence:

- **Vast** when tab/frame/webContents mapping or lifecycle ordering is wrong;
- **ECE** when its API bridge or message router loses a valid route;
- **patched Electron** when Vast's native patch changes sender metadata or delivery;
- **upstream Electron** when the defect exists on the exact unmodified Electron base;
- **Bitwarden** when it targets an already-destroyed recipient in the same way under Chrome.

Only class B is patched in this phase.

## Gate 2: Proton Pass isolated

Gate 2 starts only after Gate 1 passes or has a documented, explicitly accepted class-A limitation. It uses only Proton Pass and the persistent `proton` profile. The official runtime ID is proven from the official CRX identity.

It must demonstrate:

- login and external authentication callback completion;
- optional-permission request, persistence and event delivery;
- vault synchronization;
- content-script execution and field detection on every fixture class;
- credential suggestion and manual autofill;
- correct username/password placement;
- no cross-origin or cross-frame leakage;
- credential save and update;
- popup workflow beyond initial rendering;
- worker sleep/wake;
- extension reload;
- Vast restart;
- authentication and vault-session persistence appropriate to Proton's own policy.

The known `runtime.onMessageExternal` path must be exercised after login and after restart. The process, worker and popup must remain healthy, and diagnostics must contain no `splitViewId` validation failure or Proton runtime exception attributable to the flow.

## Gate 3: combined profile

Gate 3 uses a fresh `combined` profile containing only the accepted Bitwarden and Proton builds. It does not introduce browser-side policy selecting a preferred password manager.

It must demonstrate:

- both extensions detect the same forms concurrently;
- UI injection does not corrupt the page or the other extension;
- each extension receives only its own messages;
- worker and storage isolation;
- stable upstream runtime-ID routing;
- coexistence of multiple listeners and `chrome.webRequest` handlers;
- reload of either extension while the other remains functional;
- restart with both extensions enabled;
- concurrent navigation and form insertion without crashes or lost required operations.

If both extensions show their normal UI on the same field and the result matches Chromium, that is not automatically a Vast defect. The gate records the behavior and checks only for Vast-specific corruption, leakage or routing failure.

## Popup destruction classification

`Invalid guestInstanceId` is investigated independently from password-manager acceptance. The harness repeatedly opens and closes each extension popup while recording popup webContents and guest attachment/destruction order.

It is a patch candidate only when reproduction shows functional impact, leaked resources, a crash, a stuck popup, loss of extension behavior, or Vast/ECE lifecycle ordering that differs from the expected Electron contract. A teardown-only exception with no functional impact is documented and classified; it is not patched merely to silence output.

## Restart and lifecycle state machine

Restart-sensitive cases are represented as explicit phases in `result.json`:

1. prepare and authenticate;
2. verify live worker behavior;
3. request clean Vast shutdown;
4. verify exit and durable run state;
5. relaunch the same executable and profile;
6. verify extension/session restoration;
7. allow the worker to become idle;
8. trigger wake through a fixture navigation;
9. repeat fill and popup checks.

The controller never infers completion from elapsed time. It verifies process exit, target destruction/recreation and observable behavior.

## Acceptance model

Each scenario is `pass`, `fail`, `blocked` or `observed`:

- `pass` requires machine evidence plus any required operator checkpoint;
- `fail` means a stated invariant was violated;
- `blocked` means an external prerequisite such as test-account access is unavailable;
- `observed` records non-acceptance behavior such as auto-submit.

A gate passes only when every required scenario passes and no unresolved class-B defect remains. Class-A findings must include evidence, Chrome comparison where available, and a statement of why no required operation was lost.

## Long-running operation protocol

Operations expected to take more than a few minutes run in the background. Before ending the initiating turn, record:

- the full command;
- PID and process information when available;
- log path;
- status/exit-code path;
- current progress;
- an informational ETA.

ETA never proves completion. On the next turn, inspect the existing process, status, log tail and artifacts before starting or resuming anything. Never start a duplicate build or matrix while the prior process is running or resumable.

The same protocol applies to long idle-worker tests and soak matrices. No Electron rebuild is part of Gates 1–3 unless reproduction and ownership classification prove that Electron/Chromium source is responsible.

## Compatibility with later gates

This harness becomes input to, but does not itself implement:

- the wider HTTPS/TLS/CORS/proxy/concurrency native matrix;
- source-controlled ECE and Electron runtime fingerprinting;
- main Vast production integration and fail-closed rollback;
- generic Native Messaging;
- iCloud Passwords and KeePassXC validation;
- final Vast Browser 1.0.0 release qualification.

Gate artifacts must therefore be deterministic, redacted, machine-verifiable and bound to exact extension, Electron, ECE patch and Vast revisions.

## Deliverables

- Windows trusted-test-certificate setup, verification and exact cleanup tooling.
- Multi-origin HTTPS fixture server and pages.
- A single controller with `bitwarden`, `proton` and `combined` modes.
- Persistent-profile locking and restart state machine.
- Redacted event recorder and canary leak tests.
- Bitwarden missing-receiver metadata instrumentation and classifier.
- Popup destruction lifecycle probe.
- Per-gate verifiers and a combined summary.
- Updated compatibility reports recording authenticated evidence and remaining limitations.

## Success criteria

This phase is complete when:

1. Gate 1 passes with the Bitwarden warning classified from evidence and no unresolved class-B defect.
2. Gate 2 passes under the official Proton runtime ID, including external messaging after login and restart.
3. Gate 3 passes without cross-extension data leakage, routing confusion, policy bypass or Vast-specific UI corruption.
4. No artifact contains a credential, vault payload, token, cookie or authentication query string.
5. Every result is tied to exact runtime and source fingerprints.
6. No third-party extension source was changed.
7. No Vast security policy was weakened for compatibility.
