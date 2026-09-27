# Chrome Privacy Password-Manager Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace ECE's inert chrome.privacy.services stubs with a profile-scoped, permission-gated, source-controlled compatibility implementation for unmodified password-manager extensions.

**Architecture:** Vast owns an atomic per-profile metadata store for three password-manager privacy settings. ExtensionCompatibilityRuntime exposes narrow typed callbacks to a pinned ECE 4.9.0 patch; ECE routes Chrome-shaped get/set/clear through its existing extension IPC router. The bridge stores no credentials, selects no password manager, and does not modify Electron or Chromium source.

**Tech Stack:** TypeScript 6, Node.js 24, Electron 44.3.0, Electron Chrome Extensions 4.9.0, Node test runner, git apply.

**Spec:** docs/superpowers/specs/2026-09-20-chrome-privacy-password-manager-bridge-design.md

## Global Constraints

- Do not modify Bitwarden, Proton Pass, or another third-party extension source.
- Support only services.passwordSavingEnabled, services.autofillAddressEnabled, and services.autofillCreditCardEnabled.
- A write or clear requires a declared optional privacy permission and a persisted current grant.
- Persist only schema version, key, boolean value, controller extension ID, and timestamp in the active Vast profile. Never persist credentials, vault content, messages, cookies, tokens, or form values.
- A later authorized extension may supersede one setting. Vast must not choose a password manager or create a second policy path.
- Do not run a full Electron rebuild. If an application bundle build exceeds several minutes, use the established background wrapper and report its PID, log, status path, progress, and ETA.
- Commit ECE changes as patches/electron-chrome-extensions-4.9.0-vast.patch. Verify the exact patch and fingerprint it; no fix may exist only in node_modules.
- Fail closed if store initialization or patch verification fails.

## Review Focus

- An extension that declares privacy but lacks an optional grant must not mutate state; Task 2 owns this test.
- An extension must not clear a setting controlled by another extension; Task 1 owns this test.
- A corrupt or partial metadata file must not be overwritten; Task 1 owns this test.
- The preload must expose exactly the three allowed setting keys and no broader privacy capability; Task 3 owns this test.
- Bitwarden's accepted dialog must survive restart with controlled_by_this_extension, without credential data in artifacts; Task 4 owns this test.

---

## File Structure

- Create src/main/extensions/chrome-privacy-settings.ts: validation, ownership, atomic persistence, subscriptions, and cleanup.
- Create tests/main/chrome-privacy-settings.test.ts: behavior against a temporary directory.
- Modify src/main/extensions/extension-compatibility-runtime.ts: one store per session and permission-gated ECE callbacks.
- Modify src/main/main.ts: deterministic state-root injection from the active user-data profile.
- Modify tests/main/extension-compatibility-runtime.test.ts: runtime callback and session-isolation tests.
- Create patches/electron-chrome-extensions-4.9.0-vast.patch: minimal ECE preload/CJS/ESM/type patch.
- Modify scripts/prepare-extension-compat-runtime.cjs: verify and apply that patch rather than string-editing node_modules.
- Create tests/main/extension-compatibility-patch.test.ts: pin, application, idempotence, and fingerprint tests.
- Modify src/main/extensions/extension-compatibility.ts and tests/main/extension-compatibility.test.ts: report only the proven privacy capability.
- Modify password-manager gate verifier/controller tests only to accept sanitized settings metadata.

### Task 1: Persisted Chrome Privacy Setting Store

**Files:**
- Create: src/main/extensions/chrome-privacy-settings.ts
- Create: tests/main/chrome-privacy-settings.test.ts

**Interfaces:**

    export const CHROME_PRIVACY_SERVICE_KEYS = [
      'services.passwordSavingEnabled',
      'services.autofillAddressEnabled',
      'services.autofillCreditCardEnabled'
    ] as const
    export type ChromePrivacyServiceKey = typeof CHROME_PRIVACY_SERVICE_KEYS[number]
    export type ChromePrivacyDetails = {
      value: boolean
      controllerExtensionId?: string
      updatedAt?: string
      levelOfControl: 'controllable_by_this_extension' | 'controlled_by_this_extension' | 'controlled_by_other_extensions'
    }
    export class ChromePrivacySettingsStore {
      constructor(statePath: string)
      get(extensionId: string, key: ChromePrivacyServiceKey): Promise<ChromePrivacyDetails>
      set(extensionId: string, key: ChromePrivacyServiceKey, value: boolean): Promise<ChromePrivacyDetails>
      clear(extensionId: string, key: ChromePrivacyServiceKey): Promise<ChromePrivacyDetails>
      subscribe(listener: (change: { key: ChromePrivacyServiceKey; details: ChromePrivacyDetails }) => void): () => void
      removeExtension(extensionId: string): Promise<void>
    }

- [ ] **Step 1: Write the failing tests**

    test('a setting survives restart and reports its controller', async () => {
      const first = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
      await first.set('a'.repeat(32), 'services.passwordSavingEnabled', false)
      const restarted = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
      assert.equal(
        (await restarted.get('a'.repeat(32), 'services.passwordSavingEnabled')).levelOfControl,
        'controlled_by_this_extension'
      )
    })

    test('another extension cannot clear a setting it does not control', async () => {
      const store = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
      await store.set('a'.repeat(32), 'services.autofillAddressEnabled', false)
      await assert.rejects(
        store.clear('b'.repeat(32), 'services.autofillAddressEnabled'),
        /controlled by another extension/
      )
    })

- [ ] **Step 2: Run the test and verify RED**

    node --test tests/main/chrome-privacy-settings.test.ts

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal store**

Create the exact interfaces above. Lazily load a schema-versioned JSON document; reject unknown keys, non-booleans, invalid IDs, and malformed stored JSON before a mutation. Queue writes, write statePath.tmp, then atomically rename it over statePath. Emit only after successful persistence. A successful later set supersedes the previous controller; clear only succeeds for the controller.

- [ ] **Step 4: Add edge-case tests and verify GREEN**

Add tests for invalid key and ID, failed rename preservation, controller clear, extension removal, per-key events, and distinct state files. Then run:

    node --test tests/main/chrome-privacy-settings.test.ts

Expected: PASS without test fixtures containing credential-like content.

- [ ] **Step 5: Commit**

    git add src/main/extensions/chrome-privacy-settings.ts tests/main/chrome-privacy-settings.test.ts
    git diff --cached --check
    git commit -m "feat: persist Chrome privacy service settings"

### Task 2: Runtime Permission and Session Bridge

**Files:**
- Modify: src/main/extensions/extension-compatibility-runtime.ts
- Modify: src/main/main.ts
- Modify: tests/main/extension-compatibility-runtime.test.ts

**Interfaces:**

    export interface ChromePrivacyRequest { key: string; value?: unknown }
    export interface ExtensionCompatibilityRuntimeOptions {
      privacyStatePathForSession?: (session: Session) => string
    }

ECE receives the callbacks getPrivacySetting(extension, request), setPrivacySetting(extension, request), and clearPrivacySetting(extension, request), each returning Promise<ChromePrivacyDetails>.

- [ ] **Step 1: Write the failing runtime test**

    test('privacy writes require a persisted optional privacy grant', async () => {
      const denied = await preparedFakeEceCallbacks({ granted: [] })
      await assert.rejects(
        denied.setPrivacySetting(extensionWithOptionalPrivacy, {
          key: 'services.passwordSavingEnabled', value: false
        }),
        /privacy permission is not granted/
      )
      const granted = await preparedFakeEceCallbacks({ granted: ['privacy'] })
      await granted.setPrivacySetting(extensionWithOptionalPrivacy, {
        key: 'services.passwordSavingEnabled', value: false
      })
      assert.equal(
        (await granted.getPrivacySetting(extensionWithOptionalPrivacy, {
          key: 'services.passwordSavingEnabled'
        })).levelOfControl,
        'controlled_by_this_extension'
      )
    })

- [ ] **Step 2: Run the test and verify RED**

    node --test tests/main/extension-compatibility-runtime.test.ts

Expected: FAIL because ECE receives no privacy callbacks.

- [ ] **Step 3: Implement the bridge**

Create stores lazily in a Map keyed by Session. Before every callback require: enabled compatibility gate; canonical 32-character extension ID; privacy declared in permissions or optional_permissions; and, when optional, privacy in getGrantedPermissions(extension).permissions. In main.ts derive a root below app.getPath('userData')/extension-compatibility/privacy and derive each file name from SHA-256(session.getPartition()) so partition text cannot escape that root. Remove extension control from active stores during unload, disable, and uninstall. Reject failure without mutation.

- [ ] **Step 4: Verify GREEN**

    node --test tests/main/chrome-privacy-settings.test.ts tests/main/extension-compatibility-runtime.test.ts
    npm run extension:compat:check

Expected: PASS. Do not claim the live API works until Tasks 3 and 4.

- [ ] **Step 5: Commit**

    git add src/main/main.ts src/main/extensions/extension-compatibility-runtime.ts tests/main/extension-compatibility-runtime.test.ts
    git diff --cached --check
    git commit -m "feat: bridge privacy settings into extension runtime"

### Task 3: Pinned ECE Privacy Patch and Capability Reporting

**Files:**
- Create: patches/electron-chrome-extensions-4.9.0-vast.patch
- Modify: scripts/prepare-extension-compat-runtime.cjs
- Create: tests/main/extension-compatibility-patch.test.ts
- Modify: src/main/extensions/extension-compatibility.ts
- Modify: tests/main/extension-compatibility.test.ts

**Interfaces:**

The patch adds only these implementation hooks:

    getPrivacySetting?(extension, request: { key: string }): Promise<ChromePrivacyDetails>
    setPrivacySetting?(extension, request: { key: string; value: boolean }): Promise<ChromePrivacyDetails>
    clearPrivacySetting?(extension, request: { key: string }): Promise<ChromePrivacyDetails>

The key-bound preload adapter maps only the three keys to privacy.get, privacy.set, privacy.clear, and key-specific onChange events. The CJS and ESM handlers validate the key, require an effective privacy grant, and call the runtime callback. Callback errors create runtime.lastError only for callback duration; promise errors reject. Other privacy keys remain unavailable.

- [ ] **Step 1: Write the failing patch tests**

    test('the tracked ECE patch replaces inert ChromeSetting only for approved service keys', () => {
      const patched = applyPatchToTemporaryEcePackage()
      assert.match(patched.preload, /services\.passwordSavingEnabled/)
      assert.match(patched.preload, /privacy\.set/)
      assert.doesNotMatch(patched.preload, /webRTCIPHandlingPolicy.*privacy\.set/s)
    })

    test('the patched profile reports the proven privacy capability precisely', () => {
      const result = analyzeExtensionCompatibility(validated({
        optional_permissions: ['privacy']
      }), 'patched-electron-ece')
      assert.equal(finding(result.capabilities, 'permission:privacy').status, 'supported')
    })

- [ ] **Step 2: Run the tests and verify RED**

    node --test tests/main/extension-compatibility-patch.test.ts tests/main/extension-compatibility.test.ts

Expected: FAIL because no tracked patch exists and privacy is partial.

- [ ] **Step 3: Implement the patch workflow**

Generate a unified diff from a pristine ECE 4.9.0 package. It may change only preload, CJS, ESM, and declaration files. Replace no-op ChromeSetting with a key-bound adapter; do not add WebRTC, proxy, websites, native messaging, or broad browser-default-manager APIs. Make prepare-extension-compat-runtime.cjs verify version and patch SHA-256, run git apply --check then git apply, and make --check fail when the patch is absent or mismatched. Incorporate the existing permissions/browser-alias fixes in the same patch and remove string-replacement edits. Include its hash in the runtime fingerprint.

- [ ] **Step 4: Verify GREEN**

    node --test tests/main/extension-compatibility-patch.test.ts tests/main/extension-compatibility.test.ts tests/main/extension-compatibility-runtime.test.ts
    npm run extension:compat:prepare
    npm run extension:compat:check

Expected: PASS. A second prepare must fail rather than stacking patches.

- [ ] **Step 5: Commit**

    git add patches/electron-chrome-extensions-4.9.0-vast.patch scripts/prepare-extension-compat-runtime.cjs src/main/extensions/extension-compatibility.ts tests/main/extension-compatibility-patch.test.ts tests/main/extension-compatibility.test.ts
    git diff --cached --check
    git commit -m "fix: implement Chrome privacy extension bridge"

### Task 4: Authenticated Bitwarden Regression and Gate Evidence

**Files:**
- Modify if needed: scripts/password-manager-gate/controller.cjs
- Modify if needed: scripts/password-manager-gate/verify.cjs
- Modify if needed: tests/main/password-manager-gate-controller.test.ts
- Modify after a passing run: experiments/electron-44-patches/implementation-log.md

**Interfaces:**

    type PrivacyGateEvidence = {
      extensionId: string
      optionalPrivacyGranted: boolean
      keys: Array<{ key: string; value: boolean; levelOfControl: string }>
      observedAt: string
    }

- [ ] **Step 1: Write the failing sanitized-evidence test**

    test('Bitwarden verification accepts three controlled false settings without form data', () => {
      const result = verifyPrivacyEvidence({
        extensionId: 'nngceckbapebfimnlniiiahkandclblb',
        optionalPrivacyGranted: true,
        keys: PASSWORD_MANAGER_PRIVACY_KEYS.map((key) => ({
          key, value: false, levelOfControl: 'controlled_by_this_extension'
        }))
      })
      assert.equal(result.passed, true)
      assert.doesNotMatch(JSON.stringify(result), /username|password|vault|token/i)
    })

- [ ] **Step 2: Run the test and verify RED**

    node --test tests/main/password-manager-gate-controller.test.ts

Expected: FAIL because no privacy evidence verifier exists.

- [ ] **Step 3: Implement minimal sanitized observation**

Use the existing Bitwarden service-worker CDP connection to call permissions.getAll and the three privacy get methods. Persist only extension ID, optional-grant boolean, key name, boolean value, control level, and timestamp. Reject output that contains a form field, query/fragment URL, or secret-bearing property name. Keep raw CDP results in memory only.

- [ ] **Step 4: Run source tests and prepare a build only if necessary**

    node --test tests/main/chrome-privacy-settings.test.ts tests/main/extension-compatibility-runtime.test.ts tests/main/extension-compatibility-patch.test.ts tests/main/password-manager-gate-controller.test.ts
    npm run extension:compat:check

If the TypeScript must be bundled, use the existing background launcher with BuildVast. Report PID, log, status, progress, and ETA. Never start a duplicate gate: first inspect controller status, exit code, log tail, and artifacts.

- [ ] **Step 5: Resume Gate 1**

After the rebuilt app is ready, use the existing isolated Bitwarden profile. The user selects upstream Continue and accepts Vast's standard optional privacy permission dialog. Capture only PrivacyGateEvidence. Restart Vast, reload Bitwarden, repeat the three get calls, then retest inline suggestion and manual autofill on https://login.vast-test.local. Independently classify Receiving end does not exist and Invalid guestInstanceId with redacted lifecycle metadata; do not suppress warnings and patch only a newly reproduced B defect after a fresh failing test.

- [ ] **Step 6: Verify, document, and commit after acceptance**

    npm run extension:compat:password-gate:verify -- bitwarden
    git add scripts/password-manager-gate/controller.cjs scripts/password-manager-gate/verify.cjs tests/main/password-manager-gate-controller.test.ts experiments/electron-44-patches/implementation-log.md
    git diff --cached --check
    git commit -m "test: verify Bitwarden privacy compatibility gate"

Expected: Gate 1 passes only when three controls persist, artifacts contain no credential data, inline suggestion/manual fill work, and no unresolved class-B defect remains. Otherwise document the failure and stop before Proton.

## Plan Self-Review

- Spec coverage: Tasks 1-3 cover stored state, permission checks, narrow API behavior, source-controlled ECE patching, fingerprinting, capability reporting, callbacks, and errors. Task 4 binds the work to authenticated Bitwarden acceptance. Native messaging, iCloud, Proton execution, password-manager selection, and Electron rebuilds are excluded.
- Placeholder scan: no unresolved placeholder, vague error-handling step, or cross-task shorthand remains.
- Type consistency: ChromePrivacyServiceKey and ChromePrivacyDetails originate in Task 1; the runtime callbacks in Task 2 consume those exact types; Tasks 3 and 4 retain their names.
- Review focus: every listed condition has a named task and test.
