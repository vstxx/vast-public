const path = require('node:path')
const { controlledFixtureMatchEvidence, scenarioCatalog } = require('./scenarios.cjs')

const VALID_STATUSES = new Set(['pass', 'fail', 'blocked', 'observed'])
const PROTON_ID = 'ghmbeldphafepmbegfdlkpapadhbakde'
const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb'
const PASSWORD_MANAGER_PRIVACY_KEYS = Object.freeze([
  'services.passwordSavingEnabled',
  'services.autofillAddressEnabled',
  'services.autofillCreditCardEnabled'
])

function verifyPrivacyEvidence(input) {
  const failures = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return Object.freeze({ passed: false, failures: Object.freeze(['Privacy evidence is not an object.']) })
  }
  const approvedFields = new Set(['extensionId', 'optionalPrivacyGranted', 'keys', 'observedAt'])
  if (Object.keys(input).some((field) => !approvedFields.has(field))) {
    failures.push('Privacy evidence contains a field outside the approved schema.')
  }
  if (typeof input.extensionId !== 'string' || !/^[a-p]{32}$/.test(input.extensionId)) {
    failures.push('Privacy evidence has an invalid extension identifier.')
  }
  if (input.optionalPrivacyGranted !== true) failures.push('The optional privacy permission is not granted.')
  if (Object.hasOwn(input, 'observedAt') &&
      (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt)))) {
    failures.push('Privacy evidence has an invalid observation timestamp.')
  }

  const records = Array.isArray(input.keys) ? input.keys : []
  if (records.length !== PASSWORD_MANAGER_PRIVACY_KEYS.length) {
    failures.push('Privacy evidence does not contain the exact approved setting set.')
  }
  const byKey = new Map()
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.key !== 'string' || byKey.has(record.key)) {
      failures.push('Privacy evidence contains a malformed or duplicate setting record.')
      continue
    }
    const approvedRecordFields = new Set(['key', 'value', 'levelOfControl'])
    if (Object.keys(record).some((field) => !approvedRecordFields.has(field))) {
      failures.push('A privacy setting record contains a field outside the approved schema.')
    }
    byKey.set(record.key, record)
  }
  for (const key of PASSWORD_MANAGER_PRIVACY_KEYS) {
    const record = byKey.get(key)
    if (!record || record.value !== false || record.levelOfControl !== 'controlled_by_this_extension') {
      failures.push('An approved privacy control is not disabled by this extension.')
    }
  }
  if ([...byKey.keys()].some((key) => !PASSWORD_MANAGER_PRIVACY_KEYS.includes(key))) {
    failures.push('Privacy evidence contains a setting outside the approved set.')
  }

  return Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures) })
}

function createPrivacyGateEvidence(input, now = () => new Date()) {
  const observed = now()
  const observedAt = observed instanceof Date ? observed.toISOString() : String(observed)
  const candidate = {
    ...input,
    observedAt
  }
  const verification = verifyPrivacyEvidence(candidate)
  if (!verification.passed) throw new Error('Extension privacy evidence failed the approved schema.')
  return Object.freeze({
    extensionId: candidate.extensionId,
    optionalPrivacyGranted: candidate.optionalPrivacyGranted,
    keys: Object.freeze(candidate.keys.map((record) => Object.freeze({
      key: record.key,
      value: record.value,
      levelOfControl: record.levelOfControl
    }))),
    observedAt
  })
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function verifyScenario(scenario, definition, checkpoint, fixtureEvidence, failures) {
  let accepted = true
  if (!scenario || typeof scenario !== 'object') return false
  if (scenario.id !== definition.id) {
    failures.push(`Scenario ${definition.id} has a mismatched identifier.`)
    accepted = false
  }
  if (!VALID_STATUSES.has(scenario.status)) {
    failures.push(`Scenario ${scenario.id || '(unknown)'} has an invalid status.`)
    return false
  }
  if (scenario.status === 'pass') {
    const startedAt = Date.parse(scenario.startedAt)
    const finishedAt = Date.parse(scenario.finishedAt)
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
      failures.push(`Scenario ${definition.id} has invalid completion timestamps.`)
      accepted = false
    }
    if (!Array.isArray(scenario.machineEvidence) || scenario.machineEvidence.length === 0 ||
        scenario.machineEvidence.some((item) => typeof item !== 'string' || !item)) {
      failures.push(`Scenario ${scenario.id} has no valid machine evidence.`)
      accepted = false
    }
    if (definition.id === 'username-hash-match' || definition.id === 'password-hash-match' || definition.id === 'manual-autofill') {
      const bound = Array.isArray(fixtureEvidence) && fixtureEvidence.some((evidence) =>
        scenario.machineEvidence?.includes(evidence?.id) && controlledFixtureMatchEvidence(evidence))
      if (!bound) {
        failures.push(`Scenario ${definition.id} lacks matching ${definition.id === 'manual-autofill' ? 'autofill' : 'hash'} fixture evidence.`)
        accepted = false
      }
    }
    if (definition.checkpointId) {
      if (scenario.checkpointId !== definition.checkpointId || !checkpoint || checkpoint.confirmed !== true || checkpoint.status !== 'pass' ||
          typeof checkpoint.machineEvidenceId !== 'string' || !scenario.machineEvidence?.includes(checkpoint.machineEvidenceId)) {
        failures.push(`Scenario ${scenario.id} lacks a checkpoint bound to its machine evidence.`)
        accepted = false
      }
    }
  }
  return accepted
}

function verifyBitwardenSuggestion(result, scenario, failures) {
  if (scenario?.status !== 'pass') return true
  const evidence = result.suggestionEvidence
  const allowed = ['contextType', 'eventSequence', 'extensionId', 'fixtureEvidenceId', 'id', 'observedAt']
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') === allowed.join(',') &&
    evidence.id === 'suggestion-evidence-0' &&
    evidence.extensionId === BITWARDEN_ID && evidence.contextType === 'iframe' &&
    Number.isSafeInteger(evidence.eventSequence) && evidence.eventSequence >= 0 &&
    typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt)) &&
    scenario.machineEvidence?.includes(evidence.id) &&
    Array.isArray(result.fixtureEvidence) && result.fixtureEvidence.some((fixture) => {
      if (fixture?.id !== evidence.fixtureEvidenceId || !controlledFixtureMatchEvidence(fixture) ||
          fixture.snapshot.fixture !== 'ordinary-login' ||
          new URL(fixture.snapshot.frameOrigin).hostname !== 'login.vast-test.local') return false
      const delay = Date.parse(fixture.observedAt) - Date.parse(evidence.observedAt)
      return delay >= 0 && delay <= 30_000
    })
  if (!valid) failures.push('Bitwarden suggestion lacks safe inline-list and matching-fill evidence.')
  return Boolean(valid)
}

function verifyRestartEvidence(result, scenario, failures) {
  if (scenario?.status !== 'pass') return true
  const records = result.restartEvidence
  const valid = Array.isArray(records) && records.some((evidence) => evidence &&
    typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') ===
      'exitEvent,fingerprintMatched,id,newPid,observedAt,previousPid,profilePreserved' &&
    /^restart-evidence-(0|[1-9]\d*)$/.test(evidence.id) &&
    typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt)) &&
    Number.isSafeInteger(evidence.previousPid) && evidence.previousPid > 0 &&
    Number.isSafeInteger(evidence.newPid) && evidence.newPid > 0 && evidence.newPid !== evidence.previousPid &&
    evidence.exitEvent === 'electron-exited' && evidence.fingerprintMatched === true &&
    evidence.profilePreserved === true && scenario.machineEvidence?.includes(evidence.id))
  if (!valid) failures.push('Vast restart lacks a matching graceful-exit and preserved-profile artifact.')
  return Boolean(valid)
}

function verifyBitwardenReload(result, scenario, failures) {
  if (scenario?.status !== 'pass') return true
  const evidence = result.reloadEvidence
  const allowed = ['apiOk', 'enabled', 'extensionId', 'id', 'identityPreserved', 'mode', 'observedAt',
    'outcome', 'privacyRecovered', 'runId', 'schemaVersion', 'workerRecreated']
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') === allowed.sort().join(',') &&
    /^extension-reload-probe-\d+-[a-f0-9]{8}$/.test(evidence.id) &&
    evidence.schemaVersion === 1 && evidence.mode === 'bitwarden' && evidence.runId === result.runId &&
    evidence.extensionId === BITWARDEN_ID &&
    typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt)) &&
    evidence.outcome === 'reload-and-worker-recovered' &&
    ['apiOk', 'identityPreserved', 'enabled', 'workerRecreated', 'privacyRecovered'].every((key) => evidence[key] === true) &&
    scenario.machineEvidence?.includes(evidence.id)
  if (!valid) failures.push('Bitwarden extension reload lacks manager, identity, worker, and privacy evidence.')
  return Boolean(valid)
}

function verifyBitwardenScan(result, scenario, failures) {
  if (scenario?.status !== 'pass') return true
  const evidence = result.scanEvidence
  const fixtures = ['ordinary-login', 'spa-login', 'dynamic-login', 'delayed-login',
    'same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe']
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') === 'fixtures,id,observedAt' &&
    /^fixture-scan-\d+-[a-f0-9]{8}$/.test(evidence.id) &&
    typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt)) &&
    Array.isArray(evidence.fixtures) && evidence.fixtures.join(',') === fixtures.join(',') &&
    scenario.machineEvidence?.includes(evidence.id)
  if (!valid) failures.push('Bitwarden field detection lacks complete approved HTTPS fixture scan evidence.')
  return Boolean(valid)
}

function verifyBitwardenIdle(result, scenario, failures) {
  if (scenario?.status !== 'pass') return true
  const evidence = result.idleEvidence
  const allowed = ['createSequence', 'destroySequence', 'extensionId', 'id', 'idleObserved',
    'observedAt', 'privacyRecovered', 'workerWoke']
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') === allowed.sort().join(',') &&
    /^worker-natural-idle-\d+-[a-f0-9]{8}$/.test(evidence.id) &&
    evidence.extensionId === BITWARDEN_ID &&
    typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt)) &&
    Number.isSafeInteger(evidence.destroySequence) && evidence.destroySequence >= 0 &&
    Number.isSafeInteger(evidence.createSequence) && evidence.createSequence > evidence.destroySequence &&
    evidence.idleObserved === true && evidence.workerWoke === true && evidence.privacyRecovered === true &&
    scenario.machineEvidence?.includes(evidence.id)
  if (!valid) failures.push('Bitwarden worker sleep/wake lacks ordered natural idle and privacy evidence.')
  return Boolean(valid)
}

function verifySecretCanaryEvidence(result, failures) {
  const evidence = result?.secretCanaryEvidence
  const allowed = ['canarySha256', 'id', 'leakFound', 'mode', 'observedAt',
    'probeUrlSeen', 'processLogsScanned', 'runArtifactsScanned', 'runId']
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(',') === allowed.sort().join(',') &&
    /^secret-canary-probe-\d+-[a-f0-9]{8}$/.test(evidence.id) &&
    evidence.mode === result.mode && evidence.runId === result.runId &&
    typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt)) &&
    typeof evidence.canarySha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.canarySha256) &&
    evidence.probeUrlSeen === true && evidence.runArtifactsScanned === true &&
    evidence.processLogsScanned === true && evidence.leakFound === false
  if (!valid) failures.push('Secret canary lacks an approved live navigation and artifact/log scan.')
  return Boolean(valid)
}

function verifyProfiles(profilePaths, failures) {
  if (!profilePaths || typeof profilePaths !== 'object') {
    failures.push('Persistent profile paths are missing.')
    return
  }
  const names = ['bitwarden', 'proton', 'combined']
  const paths = []
  for (const name of names) {
    const value = profilePaths[name]
    if (typeof value !== 'string' || !value) {
      failures.push(`Persistent profile path for ${name} is missing.`)
      continue
    }
    paths.push(path.resolve(value).toLowerCase())
  }
  if (paths.length === names.length && new Set(paths).size !== paths.length) {
    failures.push('Persistent password-manager profile paths overlap.')
  }
}

function verifyPrivacyRestartEvidence(mode, evidence, failures) {
  if (mode !== 'bitwarden' && mode !== 'combined') return
  if (!Array.isArray(evidence) || evidence.length < 2) {
    failures.push('Bitwarden privacy restart evidence is missing.')
    return
  }
  const observations = evidence.slice(0, 2)
  for (const item of observations) {
    const verification = verifyPrivacyEvidence(item)
    if (!verification.passed || item.extensionId !== BITWARDEN_ID ||
        typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt))) {
      failures.push('Bitwarden privacy restart evidence is invalid.')
      return
    }
  }
  if (Date.parse(observations[1].observedAt) <= Date.parse(observations[0].observedAt)) {
    failures.push('Bitwarden privacy restart evidence is not ordered across restart.')
  }
}

function verifyDefects(defects, failures) {
  if (!Array.isArray(defects)) {
    failures.push('Defect classifications are missing.')
    return
  }
  for (const defect of defects) {
    if (!defect || defect.classification === 'unclassified' || !['A', 'B'].includes(defect.classification)) {
      failures.push('An unclassified compatibility finding remains.')
      continue
    }
    if (defect?.classification === 'B' && defect.resolved !== true) {
      failures.push('An unresolved class-B compatibility defect remains.')
    }
    if (defect?.classification === 'A' && defect.resolved !== true) {
      if (!Array.isArray(defect.evidenceIds) || defect.evidenceIds.length === 0 ||
          typeof defect.chromeComparison !== 'string' || !defect.chromeComparison ||
          defect.noRequiredOperationLost !== true) {
        failures.push('An unresolved class-A finding lacks complete class-A evidence.')
      }
    }
  }
}

function verifyGateResult(result) {
  const failures = []
  if (result?.exploratory === true) failures.push('Exploratory runs cannot satisfy an acceptance gate.')
  let catalog
  try {
    catalog = scenarioCatalog(result?.mode)
  } catch {
    return Object.freeze({ passed: false, failures: ['Gate mode is invalid.'], requiredCount: 0, passedCount: 0 })
  }

  const scenarioRecords = result?.scenarios && typeof result.scenarios === 'object' ? result.scenarios : {}
  const checkpoints = result?.checkpoints && typeof result.checkpoints === 'object' ? result.checkpoints : {}
  let passedCount = 0
  const requiredCount = catalog.filter((item) => item.required).length
  for (const definition of catalog) {
    const scenario = scenarioRecords[definition.id]
    if (!scenario) {
      if (definition.required) failures.push(`Required scenario ${definition.id} is missing.`)
      continue
    }
    const checkpoint = definition.checkpointId ? checkpoints[definition.checkpointId] : undefined
    const scenarioValid = verifyScenario(scenario, definition, checkpoint, result.fixtureEvidence, failures)
    let validPass = scenarioValid
    if (result.mode === 'bitwarden' && definition.id === 'credential-suggestion') {
      validPass = verifyBitwardenSuggestion(result, scenario, failures) && validPass
    }
    if (definition.id === 'vast-restart' || definition.id === 'vast-restart-both') {
      validPass = verifyRestartEvidence(result, scenario, failures) && validPass
    }
    if (result.mode === 'bitwarden' && definition.id === 'extension-reload') {
      validPass = verifyBitwardenReload(result, scenario, failures) && validPass
    }
    if (result.mode === 'bitwarden' && ['content-script', 'field-detection'].includes(definition.id)) {
      validPass = verifyBitwardenScan(result, scenario, failures) && validPass
    }
    if (result.mode === 'bitwarden' && definition.id === 'worker-sleep-wake') {
      validPass = verifyBitwardenIdle(result, scenario, failures) && validPass
    }
    if (definition.required) {
      if (scenario.status !== 'pass') failures.push(`Required scenario ${definition.id} did not pass.`)
      else if (validPass) passedCount += 1
    }
  }

  if (!Array.isArray(result.runtimeFingerprints) || result.runtimeFingerprints.length < 2) {
    failures.push('Runtime fingerprints for pre-restart and post-restart phases are missing.')
  } else {
    const baseline = canonical(result.runtimeFingerprints[0])
    if (result.runtimeFingerprints.some((fingerprint) => canonical(fingerprint) !== baseline)) {
      failures.push('Runtime fingerprint changed across restart phases.')
    }
  }
  if (result.secretCanaryLeak !== false) failures.push('Secret canary scan did not pass.')
  verifySecretCanaryEvidence(result, failures)
  verifyPrivacyRestartEvidence(result.mode, result.privacyEvidence, failures)
  verifyDefects(result.defects, failures)
  verifyProfiles(result.profilePaths, failures)

  if (result.mode === 'proton' || result.mode === 'combined') {
    const proton = Array.isArray(result.extensions) ? result.extensions.find((item) => item?.key === 'protonpass') : undefined
    if (!proton || proton.runtimeId !== PROTON_ID) failures.push('The official Proton runtime ID was not preserved.')
  }

  return Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures), requiredCount, passedCount })
}

module.exports = { PASSWORD_MANAGER_PRIVACY_KEYS, createPrivacyGateEvidence, verifyGateResult, verifyPrivacyEvidence }
