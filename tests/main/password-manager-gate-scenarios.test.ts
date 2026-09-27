import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { CheckpointStore } = require('../../scripts/password-manager-gate/checkpoints.cjs')
const { applyFixtureEvidence, assertPrerequisites, scenarioCatalog } = require('../../scripts/password-manager-gate/scenarios.cjs')
const { verifyGateResult } = require('../../scripts/password-manager-gate/verify.cjs')

const PROTON_ID = 'ghmbeldphafepmbegfdlkpapadhbakde'

function completeResult(mode: 'bitwarden' | 'proton' | 'combined') {
  const checkpoints: Record<string, unknown> = {}
  const scenarios = Object.fromEntries(scenarioCatalog(mode).map((scenario: Record<string, unknown>) => {
    const evidenceId = ['vast-restart', 'vast-restart-both'].includes(String(scenario.id))
      ? 'restart-evidence-0'
      : mode === 'bitwarden' && scenario.id === 'extension-reload'
        ? 'extension-reload-probe-1000-abcdef01'
      : mode === 'bitwarden' && ['content-script', 'field-detection'].includes(String(scenario.id))
        ? 'fixture-scan-1000-abcdef01'
      : mode === 'bitwarden' && scenario.id === 'worker-sleep-wake'
        ? 'worker-natural-idle-1000-abcdef01'
      : mode === 'bitwarden' && scenario.id === 'credential-suggestion'
      ? 'suggestion-evidence-0'
      : ['username-hash-match', 'password-hash-match', 'manual-autofill'].includes(String(scenario.id))
      ? 'fixture-evidence-0'
      : `evidence-${scenario.id}`
    const completed = {
      ...scenario,
      status: scenario.required ? 'pass' : 'observed',
      startedAt: '2026-09-20T10:00:00.000Z',
      finishedAt: '2026-09-20T10:01:00.000Z',
      machineEvidence: scenario.required ? [evidenceId] : []
    }
    if (scenario.checkpointId) {
      checkpoints[String(scenario.checkpointId)] = {
        id: scenario.checkpointId,
        confirmed: true,
        status: 'pass',
        machineEvidenceId: evidenceId
      }
    }
    return [scenario.id, completed]
  }))
  const fingerprint = {
    schemaVersion: 1,
    electronVersion: '44.3.0',
    electronExecutableSha256: 'a'.repeat(64),
    extensions: mode === 'bitwarden'
      ? [{ key: 'bitwarden', runtimeId: 'nngceckbapebfimnlniiiahkandclblb' }]
      : mode === 'proton'
        ? [{ key: 'protonpass', runtimeId: PROTON_ID }]
        : [
            { key: 'bitwarden', runtimeId: 'nngceckbapebfimnlniiiahkandclblb' },
            { key: 'protonpass', runtimeId: PROTON_ID }
          ]
  }
  const privacyEvidence = ['2026-09-20T10:00:30.000Z', '2026-09-20T10:02:30.000Z'].map((observedAt) => ({
    extensionId: 'nngceckbapebfimnlniiiahkandclblb',
    optionalPrivacyGranted: true,
    keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ],
    observedAt
  }))
  return {
    schemaVersion: 1,
    mode,
    runId: 'test-run',
    scenarios,
    fixtureEvidence: mode === 'combined' ? [] : [{
      id: 'fixture-evidence-0',
      observedAt: '2026-09-20T10:00:30.000Z',
      snapshot: {
        fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
        usernamePresent: true, passwordPresent: true,
        usernameMatchesExpectedHash: true, passwordMatchesExpectedHash: true,
        unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
      }
    }],
    ...(mode === 'bitwarden' ? { suggestionEvidence: {
      id: 'suggestion-evidence-0', observedAt: '2026-09-20T10:00:25.000Z',
      eventSequence: 7, extensionId: 'nngceckbapebfimnlniiiahkandclblb',
      contextType: 'iframe', fixtureEvidenceId: 'fixture-evidence-0'
    } } : {}),
    restartEvidence: [{ id: 'restart-evidence-0', observedAt: '2026-09-20T10:02:00.000Z',
      previousPid: 1000, newPid: 1001, exitEvent: 'electron-exited',
      fingerprintMatched: true, profilePreserved: true }],
    ...(mode === 'bitwarden' ? { reloadEvidence: {
      id: 'extension-reload-probe-1000-abcdef01', schemaVersion: 1, runId: 'test-run',
      mode: 'bitwarden', observedAt: '2026-09-20T10:00:40.000Z',
      extensionId: 'nngceckbapebfimnlniiiahkandclblb',
      apiOk: true, identityPreserved: true, enabled: true, workerRecreated: true,
      privacyRecovered: true, outcome: 'reload-and-worker-recovered'
    } } : {}),
    ...(mode === 'bitwarden' ? { scanEvidence: {
      id: 'fixture-scan-1000-abcdef01', observedAt: '2026-09-20T10:00:35.000Z',
      fixtures: ['ordinary-login', 'spa-login', 'dynamic-login', 'delayed-login',
        'same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe']
    } } : {}),
    ...(mode === 'bitwarden' ? { idleEvidence: {
      id: 'worker-natural-idle-1000-abcdef01',
      extensionId: 'nngceckbapebfimnlniiiahkandclblb',
      observedAt: '2026-09-20T10:00:45.000Z', destroySequence: 10, createSequence: 11,
      idleObserved: true, workerWoke: true, privacyRecovered: true
    } } : {}),
    checkpoints,
    runtimeFingerprints: [structuredClone(fingerprint), structuredClone(fingerprint)],
    secretCanaryLeak: false,
    secretCanaryEvidence: {
      id: 'secret-canary-probe-1000-abcdef01', runId: 'test-run', mode,
      observedAt: '2026-09-20T10:03:00.000Z', canarySha256: 'b'.repeat(64),
      probeUrlSeen: true, runArtifactsScanned: true, processLogsScanned: true,
      leakFound: false
    },
    defects: [],
    extensions: fingerprint.extensions,
    privacyEvidence: mode === 'bitwarden' || mode === 'combined' ? privacyEvidence : [],
    profilePaths: {
      bitwarden: 'D:\\gates\\profiles\\bitwarden',
      proton: 'D:\\gates\\profiles\\proton',
      combined: 'D:\\gates\\profiles\\combined'
    }
  }
}

test('proton and combined gates require passing predecessors', () => {
  assert.doesNotThrow(() => assertPrerequisites('bitwarden', {}))
  assert.throws(() => assertPrerequisites('proton', { bitwarden: 'fail' }), /Gate 1/)
  assert.doesNotThrow(() => assertPrerequisites('proton', { bitwarden: 'pass' }))
  assert.throws(() => assertPrerequisites('combined', { bitwarden: 'pass', proton: 'blocked' }), /Gate 2/)
  assert.doesNotThrow(() => assertPrerequisites('combined', { bitwarden: 'pass', proton: 'pass' }))
})

test('isolated catalogs cover authenticated autofill, persistence and non-required auto-submit', () => {
  for (const mode of ['bitwarden', 'proton'] as const) {
    const catalog = scenarioCatalog(mode)
    const ids = new Set(catalog.map((item: { id: string }) => item.id))
    for (const id of [
      'login', 'vault-sync', 'content-script', 'field-detection', 'credential-suggestion',
      'manual-autofill', 'username-hash-match', 'password-hash-match', 'origin-frame-isolation',
      'credential-save-refill', 'credential-update-refill', 'popup-workflow', 'worker-sleep-wake',
      'extension-reload', 'vast-restart', 'auth-session-persistence', 'auto-submit'
    ]) assert.equal(ids.has(id), true, `${mode} lacks ${id}`)
    const autoSubmit = catalog.find((item: { id: string }) => item.id === 'auto-submit')
    assert.equal(autoSubmit.required, false)
    assert.equal(autoSubmit.status, 'observed')
    assert.equal(new Set(catalog.map((item: { id: string }) => item.id)).size, catalog.length)
    for (const scenario of catalog) {
      assert.equal(Object.hasOwn(scenario, 'startedAt'), true)
      assert.equal(Object.hasOwn(scenario, 'finishedAt'), true)
      assert.equal(Object.hasOwn(scenario, 'machineEvidence'), true)
      assert.equal(Object.hasOwn(scenario, 'checkpointId'), true)
      assert.equal(Object.hasOwn(scenario, 'failure'), true)
    }
  }
  const protonIds = new Set(scenarioCatalog('proton').map((item: { id: string }) => item.id))
  assert.equal(protonIds.has('permission-add-remove-persistence'), true)
  assert.equal(protonIds.has('external-messaging-health'), true)
})

test('combined catalog requires coexistence and isolation without choosing a preferred password manager', () => {
  const ids = new Set(scenarioCatalog('combined').map((item: { id: string }) => item.id))
  for (const id of [
    'dual-field-detection', 'ui-coexistence', 'message-isolation', 'worker-isolation',
    'storage-isolation', 'id-routing', 'multiple-listeners', 'webrequest-coexistence',
    'bitwarden-reload-proton-live', 'proton-reload-bitwarden-live', 'vast-restart-both',
    'concurrent-navigation-insertion'
  ]) assert.equal(ids.has(id), true, `combined lacks ${id}`)
  assert.equal([...ids].some((id) => /preferred|select-manager|policy/.test(id)), false)
})

test('checkpoint store hashes secret input separately and confirmation without evidence stays blocked', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-checkpoints-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const secrets = ['controlled-user', 'controlled-password']
  const prompts: string[] = []
  const store = new CheckpointStore({
    checkpointPath: join(root, 'checkpoints.jsonl'),
    credentialHashPath: join(root, 'credential-hashes.json'),
    readSecret: async (prompt: string) => { prompts.push(prompt); return secrets.shift() }
  })
  const hashes = await store.captureCredentialHashes()
  assert.deepEqual(hashes, {
    username: createHash('sha256').update('controlled-user').digest('hex'),
    password: createHash('sha256').update('controlled-password').digest('hex')
  })
  assert.equal(prompts.length, 2)

  const blocked = store.confirm('login-confirmed', true)
  assert.equal(blocked.status, 'blocked')
  const passed = store.confirm('vault-synced', true, 'evidence-vault-sync')
  assert.equal(passed.status, 'pass')
  const checkpointText = readFileSync(join(root, 'checkpoints.jsonl'), 'utf8')
  const hashText = readFileSync(join(root, 'credential-hashes.json'), 'utf8')
  assert.equal(checkpointText.includes('controlled-user'), false)
  assert.equal(checkpointText.includes('controlled-password'), false)
  assert.equal(hashText.includes('controlled-user'), false)
  assert.equal(hashText.includes('controlled-password'), false)
  assert.deepEqual(store.readAll().map((item: { status: string }) => item.status), ['blocked', 'pass'])
})

test('popup-only evidence cannot pass an isolated gate', () => {
  const result = completeResult('bitwarden')
  for (const scenario of Object.values(result.scenarios) as Array<Record<string, unknown>>) {
    scenario.status = 'blocked'
    scenario.machineEvidence = []
  }
  const popup = result.scenarios['popup-workflow'] as Record<string, unknown>
  popup.status = 'pass'
  popup.machineEvidence = ['popup-visible']
  assert.equal(verifyGateResult(result).passed, false)
})

test('complete isolated and combined results pass with exact required counts', () => {
  for (const mode of ['bitwarden', 'proton', 'combined'] as const) {
    const result = completeResult(mode)
    const summary = verifyGateResult(result)
    assert.equal(summary.passed, true, `${mode}: ${summary.failures.join('; ')}`)
    const required = scenarioCatalog(mode).filter((item: { required: boolean }) => item.required).length
    assert.equal(summary.requiredCount, required)
    assert.equal(summary.passedCount, required)
    assert.deepEqual(summary.failures, [])
  }
})

test('natural worker sleep cannot pass without ordered lifecycle evidence', () => {
  const result = completeResult('bitwarden')
  const idle = result.idleEvidence as Record<string, unknown>
  idle.createSequence = idle.destroySequence
  const summary = verifyGateResult(result)
  assert.equal(summary.passed, false)
  assert.equal(summary.failures.some((failure: string) => failure.includes('natural idle')), true)
})

test('matching controlled fixture evidence passes only the two hash scenarios', () => {
  const result = {
    mode: 'bitwarden',
    scenarios: Object.fromEntries(scenarioCatalog('bitwarden').map((scenario: { id: string }) => [scenario.id, scenario]))
  }
  const evidence = {
    id: 'fixture-evidence-0', observedAt: '2026-09-21T10:00:00.000Z',
    snapshot: {
      fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
      usernamePresent: true, passwordPresent: true,
      usernameMatchesExpectedHash: true, passwordMatchesExpectedHash: true,
      unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
    }
  }
  const updated = applyFixtureEvidence(result, evidence)
  for (const id of ['username-hash-match', 'password-hash-match']) {
    assert.equal(updated.scenarios[id].status, 'pass')
    assert.deepEqual(updated.scenarios[id].machineEvidence, ['fixture-evidence-0'])
  }
  assert.equal(updated.scenarios['manual-autofill'].status, 'blocked')
  assert.equal(updated.scenarios['origin-frame-isolation'].status, 'blocked')
  assert.equal(result.scenarios['username-hash-match'].status, 'blocked')
  assert.equal(applyFixtureEvidence(result, { ...evidence, snapshot: { ...evidence.snapshot, unexpectedForeignFill: true } }), result)
  assert.equal(applyFixtureEvidence(result, { ...evidence, snapshot: { ...evidence.snapshot, passwordMatchesExpectedHash: false } }), result)
})

test('verifier fails every incomplete or unsafe invariant independently', () => {
  const mutations: Array<[string, (result: ReturnType<typeof completeResult>) => void, RegExp]> = [
    ['required scenario', (result) => { result.scenarios.login.status = 'blocked' }, /login/],
    ['missing evidence', (result) => { result.scenarios['vault-sync'].machineEvidence = [] }, /machine evidence/i],
    ['unbound hash evidence', (result) => { result.scenarios['username-hash-match'].machineEvidence = ['invented'] }, /hash.*fixture evidence/i],
    ['unbound manual autofill evidence', (result) => { result.scenarios['manual-autofill'].machineEvidence = ['invented']; result.checkpoints['manual-autofill-completed'].machineEvidenceId = 'invented' }, /autofill.*fixture evidence/i],
    ['unbound Bitwarden suggestion', (result) => { result.suggestionEvidence.fixtureEvidenceId = 'invented' }, /suggestion.*evidence/i],
    ['unbound restart', (result) => { result.restartEvidence[0].profilePreserved = false }, /restart.*artifact/i],
    ['unbound Bitwarden reload', (result) => { result.reloadEvidence.workerRecreated = false }, /reload.*evidence/i],
    ['incorrect hash snapshot', (result) => { result.fixtureEvidence[0].snapshot.passwordMatchesExpectedHash = false }, /hash.*fixture evidence/i],
    ['secret-bearing hash snapshot', (result) => { (result.fixtureEvidence[0].snapshot as Record<string, unknown>).password = 'must-not-be-recorded' }, /hash.*fixture evidence/i],
    ['checkpoint mismatch', (result) => { result.checkpoints['account-authenticated'].machineEvidenceId = 'other' }, /checkpoint/i],
    ['checkpoint removed', (result) => { delete result.scenarios.login.checkpointId }, /checkpoint/i],
    ['missing completion time', (result) => { result.scenarios.login.finishedAt = undefined }, /timestamp/i],
    ['invalid status', (result) => { result.scenarios.login.status = 'unknown' }, /invalid status/i],
    ['fingerprint drift', (result) => { result.runtimeFingerprints[1].electronVersion = '45.0.0' }, /fingerprint/i],
    ['canary leak', (result) => { result.secretCanaryLeak = true }, /canary/i],
    ['missing privacy restart evidence', (result) => { result.privacyEvidence = [] }, /privacy.*restart/i],
    ['class B', (result) => { result.defects.push({ classification: 'B', resolved: false }) }, /class-B/i],
    ['unclassified warning', (result) => { result.defects.push({ classification: 'unclassified', resolved: false }) }, /unclassified/i],
    ['profile overlap', (result) => { result.profilePaths.proton = result.profilePaths.bitwarden }, /profile/i]
  ]
  for (const [name, mutate, expected] of mutations) {
    const result = completeResult('bitwarden')
    mutate(result)
    const summary = verifyGateResult(result)
    assert.equal(summary.passed, false, name)
    assert.match(summary.failures.join(' '), expected, name)
  }
})

test('Proton gate requires the official runtime ID and complete class-A evidence', () => {
  const wrongId = completeResult('proton')
  wrongId.extensions[0].runtimeId = 'delcpmegiionmmgdehjlllfblapalbob'
  assert.equal(verifyGateResult(wrongId).passed, false)
  assert.match(verifyGateResult(wrongId).failures.join(' '), /official Proton runtime ID/i)

  const incompleteA = completeResult('proton')
  incompleteA.defects.push({ classification: 'A', resolved: false, evidenceIds: ['event-1'] })
  assert.equal(verifyGateResult(incompleteA).passed, false)
  assert.match(verifyGateResult(incompleteA).failures.join(' '), /class-A evidence/i)

  const supportedA = completeResult('proton')
  supportedA.defects.push({
    classification: 'A',
    resolved: false,
    evidenceIds: ['event-1'],
    chromeComparison: 'same teardown behavior',
    noRequiredOperationLost: true
  })
  assert.equal(verifyGateResult(supportedA).passed, true)
})
