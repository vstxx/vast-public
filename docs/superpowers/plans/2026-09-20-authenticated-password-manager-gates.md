# Authenticated Password Manager Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and execute deterministic, trusted-HTTPS acceptance gates for isolated Bitwarden, isolated Proton Pass, and their combined Vast profile without exposing secrets or modifying third-party extension code.

**Architecture:** Replace the monolithic HTTP auth launcher with small CommonJS modules for target identity, TLS, fixtures, profiles, diagnostics, CDP control, scenarios and verification. A single CLI owns persistent isolated profiles and emits redacted, fingerprint-bound run artifacts; manual secret-bearing actions are explicit checkpoints, while every observable result is verified automatically.

**Tech Stack:** Node.js 24 CommonJS, Windows PowerShell certificate APIs, Electron 44.3.0, ECE 4.9.0, Chrome DevTools Protocol, Node test runner, TypeScript test files.

**Spec:** `docs/superpowers/specs/2026-09-20-authenticated-password-manager-gates-design.md`

## Global Constraints

- Implement Gate 1, then Gate 2, then Gate 3; later gates cannot start without a passing prerequisite result.
- Use separate persistent profiles named `bitwarden`, `proton` and `combined`.
- Never log message payloads, credentials, vault contents, cookies, tokens, authorization headers or authentication query strings.
- Use a normally trusted current-user Windows test CA and exact loopback host mappings; never use `--ignore-certificate-errors`, a permissive `certificate-error` handler, disabled web security or a hosts-file edit.
- Do not modify third-party extension code or source packages. A disposable runtime copy may add only the verified upstream `manifest.key` needed by Electron's unpacked loader.
- Bitwarden and Proton Pass are the only targets in this plan. Do not implement Native Messaging, iCloud Passwords or KeePassXC work.
- WebSocket redirects remain unsupported and fail closed.
- Do not patch a warning before reproducing it, classifying functional impact and assigning ownership.
- Do not run a full Electron build unless a reproduced class-B defect is proven to require Electron/Chromium source changes.
- Operations expected to exceed a few minutes run in the background and record the full command, PID, log, status file, progress and informational ETA before the initiating turn ends.
- There is no public extension beta; all work remains local/internal.

## File Structure

New implementation files:

- `scripts/password-manager-gate.cjs` — thin CLI entry point.
- `scripts/password-manager-gate/config.cjs` — modes, paths, target definitions and argument validation.
- `scripts/password-manager-gate/crx-identity.cjs` — CRX3 identity extraction and disposable runtime staging.
- `scripts/password-manager-gate/run-state.cjs` — atomic JSON, profile locks, run directories and runtime fingerprints.
- `scripts/password-manager-gate/tls.cjs` — TLS metadata validation and server credentials.
- `scripts/password-manager-gate/setup-tls.ps1` — exact current-user CA/leaf creation and trust installation.
- `scripts/password-manager-gate/remove-tls.ps1` — fingerprint-bound trust cleanup.
- `scripts/password-manager-gate/fixtures.cjs` — multi-origin HTTPS fixture server and pages.
- `scripts/password-manager-gate/redaction.cjs` — safe URLs, recursive redaction and canary detection.
- `scripts/password-manager-gate/cdp.cjs` — CDP target discovery, lifecycle events and non-secret fixture assertions.
- `scripts/password-manager-gate/checkpoints.cjs` — operator checkpoint state machine.
- `scripts/password-manager-gate/scenarios.cjs` — Gate 1–3 scenario catalog and prerequisites.
- `scripts/password-manager-gate/classify.cjs` — missing-receiver and popup teardown classification.
- `scripts/password-manager-gate/controller.cjs` — process orchestration, restart phases and result writing.
- `scripts/password-manager-gate/verify.cjs` — machine acceptance verifier.
- `scripts/password-manager-gate/start-background.ps1` — background launcher with log/status/PID metadata.
- `experiments/password-manager-gate/README.md` — operator procedure and artifact interpretation.

Tests:

- `tests/main/password-manager-gate-config.test.ts`
- `tests/main/password-manager-gate-tls.test.ts`
- `tests/main/password-manager-gate-fixtures.test.ts`
- `tests/main/password-manager-gate-redaction.test.ts`
- `tests/main/password-manager-gate-scenarios.test.ts`
- `tests/main/password-manager-gate-classification.test.ts`
- `tests/main/password-manager-gate-controller.test.ts`

Existing files modified:

- `scripts/extension-auth-gate.cjs` — temporary compatibility wrapper after the new controller works.
- `package.json` — new gate, verification and TLS commands.
- `experiments/extension-compatibility-spike/AUTHENTICATED_GATE.md` — redirect to the new procedure.
- `audit/extension-compatibility-path-b-acceptance-2026-09-19.md` — append authenticated evidence only after gates pass.
- `experiments/electron-44-patches/implementation-log.md` — append gate outcomes and any classified defects.

Shared record shapes are defined once and reused without renaming:

```js
/** @typedef {{ command: 'prepare'|'run'|'resume'|'status'|'verify'|'stop'|'tls-setup'|'tls-remove', mode?: 'bitwarden'|'proton'|'combined', dryRun: boolean, buildVast: boolean, runId?: string }} GateArguments */
/** @typedef {{ root: string, gateRoot: string, mode: 'bitwarden'|'proton'|'combined', profile: string, targets: ExtensionTarget[], patchedDist: string, electronExecutable: string }} GateConfig */
/** @typedef {{ extensionId: string, manifestKey: string, crxSha256: string }} CrxIdentity */
/** @typedef {{ key: 'bitwarden'|'protonpass', version: string, popup: string, sourcePath: string, runtimePath: string, runtimeId: string, manifestSha256: string, crxSha256: string }} ExtensionTarget */
/** @typedef {{ path: string, pid: number, runId: string, release(): void }} ProfileLock */
/** @typedef {{ schemaVersion: 1, electronVersion: string, electronExecutableSha256: string, electronPatchsetSha256: string, eceVersion: string, ecePatchSha256: string, vastCommit: string, vastDirty: boolean, vastDiffSha256: string, extensions: Array<{key:string,version:string,runtimeId:string,manifestSha256:string,crxSha256:string}> }} RuntimeFingerprint */
/** @typedef {{ pfx: Buffer, passphrase: string, rootThumbprint: string, leafThumbprint: string, dnsNames: string[], expiresAt: string }} TlsMaterial */
/** @typedef {{ port: number, origins: Record<string,string>, close(): Promise<void> }} FixtureServer */
/** @typedef {{ fixture:string,route:string,frameOrigin:string,usernamePresent:boolean,passwordPresent:boolean,usernameMatchesExpectedHash:boolean,passwordMatchesExpectedHash:boolean,unexpectedForeignFill:boolean,submitted:boolean,submissionMatchedExpectedHashes:boolean }} FixtureSnapshot */
/** @typedef {{ sequence:number,at:string,event:string,extensionId?:string,contextType?:string,targetId?:string,tabId?:number,frameId?:number,parentFrameId?:number,url?:string,lifecycleState?:string,errorClass?:string,stackLocations?:Array<{url:string,lineNumber:number,columnNumber:number}> }} SanitizedEvent */
/** @typedef {{ id:string,required:boolean,status:'pass'|'fail'|'blocked'|'observed',startedAt?:string,finishedAt?:string,machineEvidence:string[],checkpointId?:string,failure?:string }} Scenario */
/** @typedef {{ passed:boolean,failures:string[],requiredCount:number,passedCount:number }} VerificationSummary */
/** @typedef {{ classification:'A'|'B'|'unclassified',functionalLoss:boolean,reasons:string[],evidenceIds:string[] }} Classification */
/** @typedef {{ owner:'vast'|'ece'|'patched-electron'|'upstream-electron'|'bitwarden'|'unknown',reasons:string[] }} OwnerAssessment */
```

## Review Focus

- A hostile authentication URL containing tokens or query parameters must be reduced to origin and pathname before any artifact write; Task 4 owns the canary test.
- A stale profile lock must never permit two controllers to mutate one profile, while a dead PID lock must be recoverable without deleting profile data; Task 1 owns this test.
- A trusted certificate for an unlisted hostname must fail even though the four approved fixture names pass; Task 2 owns this test.
- A cross-origin or nested frame must never inherit a successful fill assertion from its parent or sibling; Task 3 owns this test.
- A missing-receiver warning with incomplete evidence must not be labeled harmless; Task 6 owns this test and makes the gate non-passing until classification is supported.

---

### Task 1: Target Configuration, Identity, Profile Locks and Fingerprints

**Files:**
- Create: `scripts/password-manager-gate/config.cjs`
- Create: `scripts/password-manager-gate/crx-identity.cjs`
- Create: `scripts/password-manager-gate/run-state.cjs`
- Create: `tests/main/password-manager-gate-config.test.ts`

**Interfaces:**
- Produces: `parseGateArgs(argv, env): GateArguments`
- Produces: `resolveGateConfig(root, args, env): GateConfig`
- Produces: `readCrxIdentity(crxPath, expectedId): CrxIdentity`
- Produces: `stageIdentityRuntime(options): ExtensionTarget`
- Produces: `acquireProfileLock(profileRoot, owner): ProfileLock`
- Produces: `releaseProfileLock(lock): void`
- Produces: `buildRuntimeFingerprint(config): RuntimeFingerprint`
- Consumes: existing registry schema and the accepted ECE/Electron patch artifacts.

- [ ] **Step 1: Write failing configuration and lock tests**

```ts
test('modes resolve to three distinct persistent profiles and exact target sets', () => {
  assert.deepEqual(resolve('bitwarden').targets.map((item) => item.key), ['bitwarden'])
  assert.deepEqual(resolve('proton').targets.map((item) => item.key), ['protonpass'])
  assert.deepEqual(resolve('combined').targets.map((item) => item.key), ['bitwarden', 'protonpass'])
  assert.equal(new Set(['bitwarden', 'proton', 'combined'].map((mode) => resolve(mode).profile)).size, 3)
})

test('live profile lock fails closed and dead lock is recoverable without deleting the profile', () => {
  const first = acquireProfileLock(profile, { pid: process.pid, runId: 'first' })
  assert.throws(() => acquireProfileLock(profile, { pid: process.pid, runId: 'second' }), /already owned/)
  releaseProfileLock(first)
  writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, runId: 'dead' }))
  assert.doesNotThrow(() => acquireProfileLock(profile, { pid: process.pid, runId: 'replacement' }))
  assert.equal(existsSync(join(profile, 'vault-sentinel')), true)
})
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run: `node --test tests/main/password-manager-gate-config.test.ts`

Expected: FAIL because `scripts/password-manager-gate/config.cjs` does not exist.

- [ ] **Step 3: Implement exact target and path configuration**

Define immutable targets:

```js
const TARGETS = Object.freeze({
  bitwarden: Object.freeze({
    key: 'bitwarden',
    sourceDirectory: 'extension-reference/bitwarden',
    popup: 'popup/index.html',
    expectedUpstreamId: 'nngceckbapebfimnlniiiahkandclblb',
    crxEnv: 'VAST_BITWARDEN_CRX'
  }),
  protonpass: Object.freeze({
    key: 'protonpass',
    sourceDirectory: 'extension-reference/protonpass',
    popup: 'popup.html',
    expectedUpstreamId: 'ghmbeldphafepmbegfdlkpapadhbakde',
    crxEnv: 'VAST_PROTON_PASS_CRX'
  })
})

const MODE_TARGETS = Object.freeze({
  bitwarden: ['bitwarden'],
  proton: ['protonpass'],
  combined: ['bitwarden', 'protonpass']
})
```

Reject unknown modes, relative CRX paths, absent official CRX files, non-MV3 manifests, reused profile paths and an Electron executable outside `VAST_PATCHED_ELECTRON_DIST`.

- [ ] **Step 4: Extract the existing CRX3 parser and make runtime staging fail closed**

Move the protobuf/key logic from `scripts/extension-auth-gate.cjs` into `crx-identity.cjs`. The staged manifest assertion must be:

```js
const before = { ...sourceManifest }
const staged = { ...sourceManifest, key: identity.manifestKey }
assert.deepEqual(Object.keys(staged).filter((key) => key !== 'key'), Object.keys(before))
assert.equal(idFromKey(Buffer.from(staged.key, 'base64')), expectedId)
```

Copy into `.vast-build/password-manager-gates/identity-runtime/<target>-<id>-<version>` and write a marker containing source manifest SHA-256, CRX SHA-256 and expected ID. Never edit `extension-reference/`.

- [ ] **Step 5: Implement atomic run state, locking and fingerprints**

Fingerprint fields:

```js
{
  schemaVersion: 1,
  electronVersion: '44.3.0',
  electronExecutableSha256,
  electronPatchsetSha256,
  eceVersion: '4.9.0',
  ecePatchSha256,
  vastCommit,
  vastDirty,
  vastDiffSha256,
  extensions: [{ key, version, runtimeId, manifestSha256, crxSha256 }]
}
```

Calculate `electronPatchsetSha256` from ordered path+content bytes of patches `0004` and `0005`. Calculate the dirty-tree hash from `git diff --binary HEAD` without placing diff contents in artifacts.

- [ ] **Step 6: Run targeted tests**

Run: `node --test tests/main/password-manager-gate-config.test.ts`

Expected: PASS with no profile deletion and stable fingerprints.

- [ ] **Step 7: Commit only Task 1 files**

```powershell
git add scripts/password-manager-gate/config.cjs scripts/password-manager-gate/crx-identity.cjs scripts/password-manager-gate/run-state.cjs tests/main/password-manager-gate-config.test.ts
git commit -m "test: add password manager gate foundations"
```

### Task 2: Trusted Windows TLS Provisioning

**Files:**
- Create: `scripts/password-manager-gate/setup-tls.ps1`
- Create: `scripts/password-manager-gate/remove-tls.ps1`
- Create: `scripts/password-manager-gate/tls.cjs`
- Create: `tests/main/password-manager-gate-tls.test.ts`

**Interfaces:**
- Produces: `ensureTlsMaterial(tlsRoot): TlsMaterial`
- Produces: `validateTlsMetadata(metadata): void`
- Produces: `fixtureHostResolverRules(): string`
- Consumes: exact four fixture hostnames from `config.cjs`.

- [ ] **Step 1: Write failing TLS policy tests**

```ts
test('TLS policy names only the four approved hosts and forbids bypass flags', () => {
  assert.deepEqual(FIXTURE_HOSTS, [
    'login.vast-test.local',
    'spa.vast-test.local',
    'dynamic.vast-test.local',
    'iframe.vast-test.local'
  ])
  assert.doesNotMatch(allTlsSources, /ignore-certificate-errors|certificate-error|disable-web-security/)
  assert.match(fixtureHostResolverRules(), /^MAP login\.vast-test\.local 127\.0\.0\.1,/)
})

test('metadata rejects a leaf missing one SAN and an unexpected trusted subject', () => {
  assert.throws(() => validateTlsMetadata({ ...valid, dnsNames: FIXTURE_HOSTS.slice(1) }), /SAN/)
  assert.throws(() => validateTlsMetadata({ ...valid, rootSubject: 'CN=Other Root' }), /subject/)
})

test('hostname policy rejects every name outside the exact fixture allowlist', () => {
  assert.equal(isApprovedFixtureHost('login.vast-test.local'), true)
  assert.equal(isApprovedFixtureHost('unlisted.vast-test.local'), false)
  assert.equal(isApprovedFixtureHost('vast-test.local'), false)
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test tests/main/password-manager-gate-tls.test.ts`

Expected: FAIL because TLS modules are absent.

- [ ] **Step 3: Implement current-user CA and leaf creation**

`setup-tls.ps1` must:

1. refuse elevation-dependent stores and operate only under `Cert:\CurrentUser`;
2. reuse valid metadata only after matching root/leaf thumbprints, subject, SANs and expiry;
3. create a non-exportable root signing key and an exportable leaf key;
4. install only the root certificate into `Cert:\CurrentUser\Root`;
5. export the leaf as PFX under `.vast-build/password-manager-gates/tls/`;
6. protect the PFX and passphrase files with a current-user-only ACL;
7. write public metadata without the passphrase.

Use subjects `CN=Vast Password Manager Gate Root` and `CN=login.vast-test.local`, a 3072-bit RSA key, SHA-256, a CA basic constraint on the root, a non-CA constraint plus server-auth EKU on the leaf, and all four DNS SANs.

- [ ] **Step 4: Implement fingerprint-bound cleanup**

`remove-tls.ps1` reads metadata, verifies both subject and thumbprint, removes only those exact certificates, and leaves the ignored PFX files unless `-RemoveFiles` is explicitly passed. It must refuse a missing or mismatched metadata file.

- [ ] **Step 5: Implement Node TLS material validation**

`ensureTlsMaterial` reads public metadata, PFX and the separately ACL-protected passphrase, checks expiry is at least seven days away, and returns `{ pfx, passphrase, rootThumbprint, leafThumbprint, dnsNames }`. It never includes `passphrase` in JSON serialization.

- [ ] **Step 6: Run unit tests and a live trust setup check**

Run:

```powershell
node --test tests/main/password-manager-gate-tls.test.ts
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/setup-tls.ps1 -OutputDirectory .vast-build/password-manager-gates/tls
```

Expected: unit tests PASS; setup prints only thumbprints, SANs and expiry. It must not print the PFX password.

After Task 3 provides a socket server, repeat the trust check with `curl.exe --resolve`: every approved hostname must succeed with the Windows trust store, while `unlisted.vast-test.local` must fail hostname validation. Do not pass `--insecure`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add scripts/password-manager-gate/setup-tls.ps1 scripts/password-manager-gate/remove-tls.ps1 scripts/password-manager-gate/tls.cjs tests/main/password-manager-gate-tls.test.ts
git commit -m "test: provision trusted password gate TLS"
```

### Task 3: Multi-Origin HTTPS Fixtures and Secret-Safe Assertions

**Files:**
- Create: `scripts/password-manager-gate/fixtures.cjs`
- Create: `tests/main/password-manager-gate-fixtures.test.ts`

**Interfaces:**
- Produces: `createFixtureServer({ tls, port, expectedHashes }): Promise<FixtureServer>`
- Produces: `fixtureUrl(host, path, port): string`
- Produces: browser global `window.__vastGate.snapshot(): FixtureSnapshot`
- Consumes: `TlsMaterial` and `FIXTURE_HOSTS`.

- [ ] **Step 1: Write failing route and isolation tests**

Test the router without opening a TLS socket by injecting `{ host, method, path, body }`:

```ts
assert.equal(route('login.vast-test.local', '/login').fixture, 'ordinary-login')
assert.equal(route('spa.vast-test.local', '/spa').fixture, 'spa-login')
assert.equal(route('dynamic.vast-test.local', '/delayed').fixture, 'delayed-login')
assert.equal(route('iframe.vast-test.local', '/nested').fixture, 'nested-frame')
assert.equal(route('unknown.vast-test.local', '/login').status, 421)
```

Add a submission test whose body contains `VAST_GATE_SECRET_CANARY`; assert the response contains only booleans and no captured log/artifact contains the canary.

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test tests/main/password-manager-gate-fixtures.test.ts`

Expected: FAIL because the fixture router does not exist.

- [ ] **Step 3: Implement stable semantic forms**

Every login form uses stable IDs and browser-standard metadata:

```html
<form id="gate-login" method="post" action="/__gate/submit">
  <label for="gate-username">Username</label>
  <input id="gate-username" name="username" autocomplete="username" />
  <label for="gate-password">Password</label>
  <input id="gate-password" name="password" type="password" autocomplete="current-password" />
  <button id="gate-submit" type="submit">Sign in</button>
</form>
```

Implement ordinary, SPA, immediate dynamic, delayed, same-origin iframe, cross-origin iframe, nested iframe and dynamically-created iframe routes. SPA transitions use `history.pushState` plus DOM replacement without reload.

- [ ] **Step 4: Implement non-secret browser assertions**

`window.__vastGate.snapshot()` returns only:

```js
{
  fixture,
  route,
  frameOrigin,
  usernamePresent,
  passwordPresent,
  usernameMatchesExpectedHash,
  passwordMatchesExpectedHash,
  unexpectedForeignFill,
  submitted,
  submissionMatchedExpectedHashes
}
```

Hash comparisons happen in the page with Web Crypto against injected expected hashes. Never expose expected plaintext through the page configuration.

- [ ] **Step 5: Bound and discard save/update submissions**

Reject bodies above 64 KiB. Parse only `username` and `password`, compare SHA-256 values in memory, respond with booleans, then drop references. Do not log headers or bodies.

- [ ] **Step 6: Run fixture tests**

Run: `node --test tests/main/password-manager-gate-fixtures.test.ts`

Expected: PASS for every route, frame identity and canary non-leak assertion.

- [ ] **Step 7: Commit Task 3**

```powershell
git add scripts/password-manager-gate/fixtures.cjs tests/main/password-manager-gate-fixtures.test.ts
git commit -m "test: add multi-origin password fixtures"
```

### Task 4: Redacted Diagnostics and CDP Observation

**Files:**
- Create: `scripts/password-manager-gate/redaction.cjs`
- Create: `scripts/password-manager-gate/cdp.cjs`
- Create: `tests/main/password-manager-gate-redaction.test.ts`

**Interfaces:**
- Produces: `sanitizeEvent(event): SanitizedEvent`
- Produces: `assertArtifactHasNoSecrets(path, canaries): void`
- Produces: `CdpObserver` with `start()`, `snapshotTargets()`, `evaluateFixture()` and `stop()`.
- Consumes: run-state atomic writer and fixture snapshot API.

- [ ] **Step 1: Write failing hostile-input redaction tests**

```ts
const event = sanitizeEvent({
  url: 'https://account.proton.me/auth-ext?token=VAST_GATE_TOKEN_CANARY',
  cookie: 'VAST_GATE_COOKIE_CANARY',
  authorization: 'Bearer VAST_GATE_AUTH_CANARY',
  message: { payload: 'VAST_GATE_PAYLOAD_CANARY' },
  stack: 'at fn (https://account.proton.me/auth-ext?code=secret:3:4)'
})
assert.equal(event.url, 'https://account.proton.me/auth-ext')
assert.equal(JSON.stringify(event).includes('CANARY'), false)
```

Test encoded query strings, fragments, nested arrays, Error objects and circular input.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/main/password-manager-gate-redaction.test.ts`

Expected: FAIL because the sanitizer and observer do not exist.

- [ ] **Step 3: Implement allowlist-based event serialization**

Do not recursively copy arbitrary objects. Construct each event type from allowed fields: timestamp, sequence, event name, extension ID, context type, target ID, tab/frame IDs, origin+pathname, lifecycle state, error class and sanitized stack locations. Drop keys matching `payload|body|cookie|token|authorization|password|username|secret|query` case-insensitively.

- [ ] **Step 4: Implement CDP target and lifecycle observation**

Enable only `Runtime`, `Log`, `Page` and `Target` domains. Record target creation/destruction, exception location, frame-tree identity and worker lifecycle. `Runtime.consoleAPICalled` records level and source location but never argument values. `evaluateFixture()` evaluates only `window.__vastGate.snapshot()` on approved fixture origins.

- [ ] **Step 5: Run tests and scan generated fixtures**

Run: `node --test tests/main/password-manager-gate-redaction.test.ts`

Expected: PASS; all canaries absent from JSONL and process logs.

- [ ] **Step 6: Commit Task 4**

```powershell
git add scripts/password-manager-gate/redaction.cjs scripts/password-manager-gate/cdp.cjs tests/main/password-manager-gate-redaction.test.ts
git commit -m "test: add redacted extension diagnostics"
```

### Task 5: Scenario Catalog, Checkpoints and Acceptance Verifier

**Files:**
- Create: `scripts/password-manager-gate/checkpoints.cjs`
- Create: `scripts/password-manager-gate/scenarios.cjs`
- Create: `scripts/password-manager-gate/verify.cjs`
- Create: `tests/main/password-manager-gate-scenarios.test.ts`

**Interfaces:**
- Produces: `scenarioCatalog(mode): Scenario[]`
- Produces: `CheckpointStore`
- Produces: `verifyGateResult(result): VerificationSummary`
- Consumes: fixture snapshots, diagnostics and runtime fingerprint.

- [ ] **Step 1: Write failing ordering and completeness tests**

```ts
test('proton and combined gates require passing predecessors', () => {
  assert.throws(() => assertPrerequisites('proton', { bitwarden: 'fail' }), /Gate 1/)
  assert.throws(() => assertPrerequisites('combined', { bitwarden: 'pass', proton: 'blocked' }), /Gate 2/)
})

test('popup-only evidence cannot pass an isolated gate', () => {
  const result = emptyResult('bitwarden')
  result.scenarios.popup.status = 'pass'
  assert.equal(verifyGateResult(result).passed, false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/main/password-manager-gate-scenarios.test.ts`

Expected: FAIL because the scenario modules do not exist.

- [ ] **Step 3: Define the complete scenario catalogs**

Bitwarden and Proton catalogs contain login, vault sync, content-script presence, field detection, credential suggestion, manual autofill, correct username/password hash matches, cross-origin/frame non-leakage, credential save and refill, credential update and refill, popup workflow, worker sleep/wake, extension reload, Vast restart and auth/session persistence across restart. Auto-submit is `observed`, never required. Proton additionally requires permission add/remove persistence and `runtime.onMessageExternal` health. Combined adds UI coexistence, message/worker/storage/ID isolation, multiple listeners, webRequest coexistence and one-extension reload.

Every scenario records `status`, `startedAt`, `finishedAt`, `machineEvidence`, optional `checkpointId`, and `failure`. Only `pass`, `fail`, `blocked` and `observed` are valid.

- [ ] **Step 4: Implement non-echoing checkpoint handling**

Use `readline` with output muted only for secret entry. Store credential SHA-256 hashes separately from checkpoint records. Ordinary checkpoints store operator confirmation plus matching machine evidence ID; confirmation without evidence stays `blocked`.

- [ ] **Step 5: Implement verifier invariants**

Fail when any required scenario is not `pass`, runtime fingerprints differ across restart phases, a prohibited secret canary is present, an unresolved class-B defect exists, Proton's runtime ID differs, or profile paths overlap.

- [ ] **Step 6: Run tests**

Run: `node --test tests/main/password-manager-gate-scenarios.test.ts`

Expected: PASS for valid complete results and FAIL for every incomplete/unsafe fixture.

- [ ] **Step 7: Commit Task 5**

```powershell
git add scripts/password-manager-gate/checkpoints.cjs scripts/password-manager-gate/scenarios.cjs scripts/password-manager-gate/verify.cjs tests/main/password-manager-gate-scenarios.test.ts
git commit -m "test: define authenticated extension acceptance"
```

### Task 6: Evidence-Based Warning and Popup Classification

**Files:**
- Create: `scripts/password-manager-gate/classify.cjs`
- Create: `tests/main/password-manager-gate-classification.test.ts`

**Interfaces:**
- Produces: `classifyMissingReceiver(events, operationEvidence): Classification`
- Produces: `classifyPopupTeardown(events, operationEvidence): Classification`
- Produces: `assignLikelyOwner(evidence): OwnerAssessment`
- Consumes: sanitized ordered events only.

- [ ] **Step 1: Write failing classifier tests**

```ts
test('missing receiver is A only when destruction precedes send and no operation is lost', () => {
  const result = classifyMissingReceiver(destroyedRecipientEvents, allRequiredOperationsPassed)
  assert.equal(result.classification, 'A')
  assert.equal(result.functionalLoss, false)
})

test('live expected recipient plus lost fill is B', () => {
  const result = classifyMissingReceiver(liveRecipientEvents, { fill: 'fail' })
  assert.equal(result.classification, 'B')
})

test('incomplete evidence cannot be called harmless', () => {
  assert.equal(classifyMissingReceiver([{ event: 'missing-receiver' }], {}).classification, 'unclassified')
})
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/main/password-manager-gate-classification.test.ts`

Expected: FAIL because `classify.cjs` does not exist.

- [ ] **Step 3: Implement strict classification rules**

Class A requires a destroyed/navigated recipient before `Could not establish connection. Receiving end does not exist`, no live replacement expected for the operation, and all correlated required operations passing. Class B requires a live expected recipient or a lost required operation. Otherwise return `unclassified`, which prevents gate acceptance and requests more evidence rather than guessing.

- [ ] **Step 4: Implement ownership evidence rules**

Return an assessment with evidence, not a patch recommendation:

```js
{ owner: 'vast' | 'ece' | 'patched-electron' | 'upstream-electron' | 'bitwarden' | 'unknown', reasons: [] }
```

Vast ownership requires incorrect tab/frame/webContents mapping. ECE requires a valid route lost inside its bridge. Patched Electron requires behavior introduced by the accepted native patch. Upstream Electron requires reproduction on the exact unmodified base. Bitwarden requires targeting a destroyed recipient matching Chrome behavior.

- [ ] **Step 5: Implement popup teardown classification**

Require at least 20 open/close cycles with ordered `did-attach`, target creation, `destroyed`, detach and exception events. Class B requires crash, leaked target/process, stuck popup or lost subsequent popup operation. A teardown-only `Invalid guestInstanceId` with 20 successful cycles is recorded as class A, not suppressed.

- [ ] **Step 6: Run tests**

Run: `node --test tests/main/password-manager-gate-classification.test.ts`

Expected: PASS, including the Review Focus incomplete-evidence case.

- [ ] **Step 7: Commit Task 6**

```powershell
git add scripts/password-manager-gate/classify.cjs tests/main/password-manager-gate-classification.test.ts
git commit -m "test: classify extension lifecycle warnings"
```

### Task 7: Controller, Restart State Machine and Background Protocol

**Files:**
- Create: `scripts/password-manager-gate/controller.cjs`
- Create: `scripts/password-manager-gate/start-background.ps1`
- Create: `scripts/password-manager-gate.cjs`
- Create: `tests/main/password-manager-gate-controller.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces CLI commands: `prepare`, `run`, `resume`, `status`, `verify`, `stop`, `tls-setup`, `tls-remove`.
- Produces: `PasswordManagerGateController` with injectable process, server and CDP adapters.
- Consumes: all Task 1–6 modules.

- [ ] **Step 1: Write failing controller tests with fakes**

Cover exact launch arguments, no bypass flags, same profile across restart, official target set per mode, atomic status transitions, clean shutdown and recovery after a dead launcher PID.

```ts
assert.deepEqual(launch.args.filter((arg) => arg.startsWith('--host-resolver-rules=')), [expectedRules])
assert.equal(launch.args.some((arg) => arg.includes('ignore-certificate-errors')), false)
assert.equal(first.env.VAST_DEV_USER_DATA_DIR, second.env.VAST_DEV_USER_DATA_DIR)
assert.equal(first.env.VAST_RELAY_ENABLED, '0')
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/main/password-manager-gate-controller.test.ts`

Expected: FAIL because the controller is absent.

- [ ] **Step 3: Implement prepare and launch**

`prepare <mode>` validates TLS, CRX identities, ECE patch anchors, Electron binary, profile lock availability and prerequisites. `run <mode>` starts the HTTPS server, writes `command.json`, launches visible Electron, starts CDP observation and moves status from `preparing` to `running`.

Do not run `scripts/build-app.cjs` implicitly. Add an explicit `--build-vast` option so ordinary resume never triggers a surprise multi-minute build.

- [ ] **Step 4: Implement the restart state machine**

On a restart checkpoint, request graceful app shutdown, require an `electron-exited` event, preserve server/profile/run ID, relaunch the same executable and compare the fresh runtime fingerprint before continuing. Never use elapsed time as completion evidence.

- [ ] **Step 5: Implement background metadata**

`start-background.ps1` writes:

```json
{
  "command": "node scripts/password-manager-gate.cjs run bitwarden",
  "controllerPid": 1234,
  "startedAt": "...",
  "log": ".../process.log",
  "status": ".../status"
}
```

It launches the controller hidden but leaves Electron visible. Status contains `running` until final numeric exit code. It refuses a live profile lock or an already-running command.

- [ ] **Step 6: Add package commands**

```json
"extension:compat:password-gate": "node scripts/password-manager-gate.cjs",
"extension:compat:password-gate:verify": "node scripts/password-manager-gate.cjs verify"
```

- [ ] **Step 7: Run controller tests and a dry-run prepare**

Run:

```powershell
node --test tests/main/password-manager-gate-controller.test.ts
npm run extension:compat:password-gate -- prepare bitwarden --dry-run
```

Expected: tests PASS; dry run reports exact paths and missing external prerequisites without modifying a profile.

- [ ] **Step 8: Commit Task 7**

```powershell
git add scripts/password-manager-gate/controller.cjs scripts/password-manager-gate/start-background.ps1 scripts/password-manager-gate.cjs tests/main/password-manager-gate-controller.test.ts package.json
git commit -m "test: orchestrate authenticated extension gates"
```

### Task 8: Migrate the Existing Auth Gate Without Losing Profiles

**Files:**
- Modify: `scripts/extension-auth-gate.cjs`
- Modify: `experiments/extension-compatibility-spike/AUTHENTICATED_GATE.md`
- Create: `experiments/password-manager-gate/README.md`

**Interfaces:**
- Consumes: new CLI/controller.
- Produces: legacy command warning and explicit migration instructions; it never silently moves or deletes the existing shared profile.

- [ ] **Step 1: Add a source-level regression test to the controller test file**

Assert the legacy entry point delegates only when an explicit mode is provided and otherwise prints the old profile path plus a refusal to reuse it for an isolated gate.

- [ ] **Step 2: Run the regression test and verify failure**

Run: `node --test tests/main/password-manager-gate-controller.test.ts`

Expected: FAIL because the legacy launcher still starts a combined HTTP profile.

- [ ] **Step 3: Replace the legacy launcher with a compatibility wrapper**

The wrapper must not delete `.vast-build/extension-auth-gate/profile`. It prints that the profile is preserved for historical evidence and directs operators to:

```powershell
npm run extension:compat:password-gate -- prepare bitwarden
```

An explicit `--legacy-shared-http` may retain read-only diagnostic access temporarily, but cannot produce a passing result.

- [ ] **Step 4: Document exact setup and recovery**

The new README documents TLS setup/removal, CRX environment variables, profile paths, checkpoint semantics, background status inspection, secret-handling rules and the requirement to inspect an existing process before any restart.

- [ ] **Step 5: Run tests and documentation command checks**

Run:

```powershell
node --check scripts/extension-auth-gate.cjs
node --check scripts/password-manager-gate.cjs
node --test tests/main/password-manager-gate-controller.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```powershell
git add scripts/extension-auth-gate.cjs experiments/extension-compatibility-spike/AUTHENTICATED_GATE.md experiments/password-manager-gate/README.md tests/main/password-manager-gate-controller.test.ts
git commit -m "docs: migrate authenticated extension gate"
```

### Task 9: Execute and Classify Gate 1 — Bitwarden Isolated

**Files:**
- Runtime artifacts: `.vast-build/password-manager-gates/runs/<run-id>/`
- Modify after evidence: `experiments/electron-44-patches/implementation-log.md`

**Interfaces:**
- Consumes: `bitwarden` mode, official Bitwarden CRX, controlled Bitwarden test account.
- Produces: passing Gate 1 result or a reproduced class-B defect report with assigned layer.

- [ ] **Step 1: Run all targeted unit tests before live execution**

Run:

```powershell
node --test tests/main/password-manager-gate-config.test.ts tests/main/password-manager-gate-tls.test.ts tests/main/password-manager-gate-fixtures.test.ts tests/main/password-manager-gate-redaction.test.ts tests/main/password-manager-gate-scenarios.test.ts tests/main/password-manager-gate-classification.test.ts tests/main/password-manager-gate-controller.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Check for an existing controller before starting**

Run:

```powershell
npm run extension:compat:password-gate -- status bitwarden
```

Inspect live PID, status/exit code, log tail and artifacts. Resume a valid existing run; do not start a duplicate.

- [ ] **Step 3: Prepare trusted TLS and Bitwarden identity**

Run:

```powershell
npm run extension:compat:password-gate -- tls-setup
npm run extension:compat:password-gate -- prepare bitwarden
```

Expected: trusted TLS preflight passes; Bitwarden runtime ID equals `nngceckbapebfimnlniiiahkandclblb`; the `bitwarden` profile is the only profile selected.

- [ ] **Step 4: Start Gate 1 in the background and pause Codex**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/start-background.ps1 -Mode bitwarden
```

Before ending the turn, report the exact command, PID, log, status path, current checkpoint and ETA. Do not wait actively for user login, worker idle periods or restart checkpoints.

- [ ] **Step 5: Resume only after inspecting existing state**

On the next turn run `status bitwarden`, inspect the PID, status, log tail and result artifacts, then continue the pending checkpoint. Never restart from scratch unless the run is irrecoverably failed and the profile is preserved.

- [ ] **Step 6: Classify the Bitwarden missing-receiver warning**

Produce A or B with correlated sender/receiver context, target lifecycle and operation evidence. If evidence remains incomplete, Gate 1 stays blocked. Patch only a reproduced B, in the assigned layer, with a new failing test first. A finding receives documentation only.

When the evidence suggests Bitwarden itself targets a destroyed context, repeat the same action with the identical staged extension version and fixtures in a separate Chrome baseline profile. Record only the same redacted lifecycle metadata. If Chrome is unavailable or the behavior cannot be reproduced safely, do not assign ownership to Bitwarden from inference alone.

- [ ] **Step 7: Verify Gate 1 and record evidence**

Run:

```powershell
npm run extension:compat:password-gate:verify -- bitwarden
```

Expected: every required scenario passes, secrets scan is clean, fingerprints match and no unresolved B remains.

- [ ] **Step 8: Commit the Gate 1 evidence summary only**

```powershell
git add experiments/electron-44-patches/implementation-log.md
git commit -m "docs: record isolated Bitwarden gate"
```

Do not commit ignored run artifacts or certificate material.

### Task 10: Execute Gate 2 — Proton Pass Isolated

**Files:**
- Runtime artifacts: `.vast-build/password-manager-gates/runs/<run-id>/`
- Modify after evidence: `experiments/electron-44-patches/implementation-log.md`

**Interfaces:**
- Consumes: passing Gate 1 result, `proton` mode, official Proton CRX, controlled Proton test account.
- Produces: passing Gate 2 result or a reproduced defect report.

- [ ] **Step 1: Verify Gate 1 prerequisite and existing Proton process state**

Run:

```powershell
npm run extension:compat:password-gate:verify -- bitwarden
npm run extension:compat:password-gate -- status proton
```

Expected: Gate 1 PASS and no conflicting live Proton controller.

- [ ] **Step 2: Prepare Proton identity and isolated profile**

Run: `npm run extension:compat:password-gate -- prepare proton`

Expected: runtime ID `ghmbeldphafepmbegfdlkpapadhbakde`; no Bitwarden record in the Proton profile.

- [ ] **Step 3: Start Gate 2 in the background and pause Codex**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/start-background.ps1 -Mode proton
```

Report command, PID, log, status, checkpoint and ETA, then end the turn.

- [ ] **Step 4: Exercise Proton-specific acceptance**

In addition to all HTTPS fixtures, require permission add/remove persistence, authenticated `/auth-ext` callback, vault synchronization and `runtime.onMessageExternal` after login and after restart. Zero `splitViewId` validation failures and zero correlated Proton worker exceptions are required.

- [ ] **Step 5: Verify and record Gate 2**

Run: `npm run extension:compat:password-gate:verify -- proton`

Expected: PASS with matching fingerprints and secret scan.

- [ ] **Step 6: Commit the Gate 2 evidence summary only**

```powershell
git add experiments/electron-44-patches/implementation-log.md
git commit -m "docs: record isolated Proton gate"
```

### Task 11: Execute Gate 3 — Combined Profile

**Files:**
- Runtime artifacts: `.vast-build/password-manager-gates/runs/<run-id>/`
- Modify after evidence: `experiments/electron-44-patches/implementation-log.md`
- Modify after full completion: `audit/extension-compatibility-path-b-acceptance-2026-09-19.md`

**Interfaces:**
- Consumes: passing Gate 1 and Gate 2 results.
- Produces: combined coexistence result and final authenticated-gate summary.

- [ ] **Step 1: Verify prerequisites and profile isolation**

Run:

```powershell
npm run extension:compat:password-gate:verify -- bitwarden
npm run extension:compat:password-gate:verify -- proton
npm run extension:compat:password-gate -- prepare combined
```

Expected: both isolated gates PASS; combined profile path differs from both isolated paths and contains only the two expected extension records.

- [ ] **Step 2: Start Gate 3 in the background and pause Codex**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/password-manager-gate/start-background.ps1 -Mode combined
```

Report command, PID, log, status, checkpoint and ETA, then end the turn.

- [ ] **Step 3: Execute coexistence scenarios**

Verify concurrent field detection, normal dual UI behavior, no page corruption, message/worker/storage/ID isolation, multiple listeners, webRequest coexistence, reload of each extension while the other remains active, restart and navigation/form-insertion races.

- [ ] **Step 4: Verify Gate 3**

Run: `npm run extension:compat:password-gate:verify -- combined`

Expected: PASS with no cross-origin fill, cross-extension route, storage leak, Vast policy bypass, crash or unresolved class-B defect.

- [ ] **Step 5: Update acceptance documents from evidence**

Append exact versions, runtime IDs, run IDs, fingerprint summaries, scenario counts, warning classifications and remaining limitations. Do not copy authentication URLs, account data or ignored artifacts into tracked docs.

- [ ] **Step 6: Commit Gate 3 evidence**

```powershell
git add experiments/electron-44-patches/implementation-log.md audit/extension-compatibility-path-b-acceptance-2026-09-19.md
git commit -m "docs: accept authenticated password manager gates"
```

### Task 12: Final Regression and Handoff to Gate 4

**Files:**
- Modify if needed: `experiments/password-manager-gate/README.md`
- Modify if needed: `docs/superpowers/specs/2026-09-20-authenticated-password-manager-gates-design.md`

**Interfaces:**
- Consumes: all implementation commits and passing Gate 1–3 results.
- Produces: verified Gate 1–3 handoff; no Gate 4 implementation.

- [ ] **Step 1: Run syntax, focused tests and compatibility checks**

Run:

```powershell
node --check scripts/password-manager-gate.cjs
Get-ChildItem scripts/password-manager-gate -Filter *.cjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { throw "Syntax failed: $($_.FullName)" } }
$gateTests = Get-ChildItem -LiteralPath tests/main -Filter 'password-manager-gate-*.test.ts' | Select-Object -ExpandProperty FullName
node --test $gateTests
npm run extension:compat:check
npm run license:gpl:check
```

Expected: all commands PASS.

- [ ] **Step 2: Run project lint and full unit tests**

Run:

```powershell
npm run lint
npm test
```

If either command is expected to exceed a few minutes, launch it through a background wrapper with separate log/status files, report PID and ETA, and end the turn. On resume, inspect the existing process before starting anything else.

- [ ] **Step 3: Re-verify all three live results without rerunning them**

Run:

```powershell
npm run extension:compat:password-gate:verify -- bitwarden
npm run extension:compat:password-gate:verify -- proton
npm run extension:compat:password-gate:verify -- combined
```

Expected: three PASS results bound to exact fingerprints and clean secret scans.

- [ ] **Step 4: Verify worktree scope and patch policy**

Run:

```powershell
git diff --check
git status --short
```

Confirm no certificate, PFX, passphrase, vault data, run artifact, extension package or third-party extension edit is tracked. Confirm no Electron build ran unless a documented class-B native defect required it.

- [ ] **Step 5: Commit final documentation corrections**

```powershell
git add experiments/password-manager-gate/README.md docs/superpowers/specs/2026-09-20-authenticated-password-manager-gates-design.md
git diff --cached --check
git commit -m "docs: finalize authenticated extension gate"
```

Skip the commit when no tracked correction is needed.

- [ ] **Step 6: Stop before Gate 4**

Report Gate 1–3 evidence, class-A limitations, any fixed class-B defects, test results and the exact next design boundary. Do not begin the wider native network/lifecycle/security matrix until its own plan is reviewed.
