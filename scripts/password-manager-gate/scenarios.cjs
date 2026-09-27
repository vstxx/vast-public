const VALID_MODES = new Set(['bitwarden', 'proton', 'combined'])
const { cleanSnapshot } = require('./cdp.cjs')

const ISOLATED_SCENARIOS = Object.freeze([
  ['login', true, 'account-authenticated'],
  ['vault-sync', true, 'test-vault-synchronized'],
  ['content-script', true],
  ['field-detection', true],
  ['credential-suggestion', true, 'controlled-credential-selected'],
  ['manual-autofill', true, 'manual-autofill-completed'],
  ['username-hash-match', true],
  ['password-hash-match', true],
  ['origin-frame-isolation', true],
  ['credential-save-refill', true, 'save-prompt-accepted'],
  ['credential-update-refill', true, 'update-prompt-accepted'],
  ['popup-workflow', true, 'popup-workflow-confirmed'],
  ['worker-sleep-wake', true],
  ['extension-reload', true],
  ['vast-restart', true],
  ['auth-session-persistence', true, 'session-persistence-confirmed'],
  ['auto-submit', false]
])

const PROTON_ADDITIONS = Object.freeze([
  ['permission-add-remove-persistence', true, 'permission-workflow-confirmed'],
  ['external-messaging-health', true]
])

const COMBINED_SCENARIOS = Object.freeze([
  ['dual-field-detection', true],
  ['ui-coexistence', true, 'combined-ui-reviewed'],
  ['message-isolation', true],
  ['worker-isolation', true],
  ['storage-isolation', true],
  ['id-routing', true],
  ['multiple-listeners', true],
  ['webrequest-coexistence', true],
  ['bitwarden-reload-proton-live', true],
  ['proton-reload-bitwarden-live', true],
  ['vast-restart-both', true],
  ['concurrent-navigation-insertion', true],
  ['auto-submit', false]
])

function createScenario([id, required, checkpointId]) {
  return {
    id,
    required,
    status: required ? 'blocked' : 'observed',
    startedAt: undefined,
    finishedAt: undefined,
    machineEvidence: [],
    checkpointId,
    failure: undefined
  }
}

function scenarioCatalog(mode) {
  if (!VALID_MODES.has(mode)) throw new Error(`Unknown password-manager gate mode: ${mode}`)
  const definitions = mode === 'combined'
    ? COMBINED_SCENARIOS
    : mode === 'proton'
      ? [...ISOLATED_SCENARIOS, ...PROTON_ADDITIONS]
      : ISOLATED_SCENARIOS
  return definitions.map(createScenario)
}

function controlledFixtureMatchEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      !/^fixture-evidence-(0|[1-9]\d*)$/.test(evidence.id) ||
      typeof evidence.observedAt !== 'string' || !Number.isFinite(Date.parse(evidence.observedAt)) ||
      Object.keys(evidence).sort().join(',') !== 'id,observedAt,snapshot') return false
  try {
    const snapshot = cleanSnapshot(evidence.snapshot)
    if (Object.keys(evidence.snapshot).sort().join(',') !== Object.keys(snapshot).sort().join(',')) return false
    return snapshot.usernamePresent && snapshot.passwordPresent &&
      snapshot.usernameMatchesExpectedHash && snapshot.passwordMatchesExpectedHash &&
      !snapshot.unexpectedForeignFill
  } catch {
    return false
  }
}

function applyFixtureEvidence(result, evidence) {
  if (!['bitwarden', 'proton'].includes(result?.mode) || !controlledFixtureMatchEvidence(evidence) ||
      !result.scenarios || typeof result.scenarios !== 'object') return result
  let changed = false
  const scenarios = { ...result.scenarios }
  for (const id of ['username-hash-match', 'password-hash-match']) {
    const current = scenarios[id]
    if (current?.id !== id || current.status !== 'blocked') continue
    scenarios[id] = {
      ...current,
      status: 'pass',
      startedAt: current.startedAt || evidence.observedAt,
      finishedAt: evidence.observedAt,
      machineEvidence: [evidence.id]
    }
    changed = true
  }
  return changed ? { ...result, scenarios } : result
}

function prerequisiteStatus(history, mode) {
  const value = history?.[mode]
  return typeof value === 'string' ? value : value?.status
}

function assertPrerequisites(mode, history = {}) {
  if (!VALID_MODES.has(mode)) throw new Error(`Unknown password-manager gate mode: ${mode}`)
  if (mode === 'bitwarden') return
  const gate1 = prerequisiteStatus(history, 'bitwarden')
  if (gate1 !== 'pass' && gate1 !== 'accepted-class-a') {
    throw new Error('Gate 1 (Bitwarden isolated) must pass before this gate can start.')
  }
  if (mode === 'combined' && prerequisiteStatus(history, 'proton') !== 'pass') {
    throw new Error('Gate 2 (Proton Pass isolated) must pass before Gate 3 can start.')
  }
}

module.exports = { applyFixtureEvidence, assertPrerequisites, controlledFixtureMatchEvidence, scenarioCatalog }
