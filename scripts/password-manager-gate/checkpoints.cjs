const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline/promises')
const { Writable } = require('node:stream')
const { writeJsonAtomic } = require('./run-state.cjs')
const { controlledFixtureMatchEvidence, scenarioCatalog } = require('./scenarios.cjs')

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readSecretMuted(prompt, input = process.stdin, output = process.stdout) {
  output.write(prompt)
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const terminal = Boolean(input.isTTY && output.isTTY)
  const interface_ = readline.createInterface({ input, output: muted, terminal })
  try {
    return await interface_.question('')
  } finally {
    interface_.close()
    output.write('\n')
  }
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a non-secret stable identifier.`)
  }
  return value
}

class CheckpointStore {
  constructor({ checkpointPath, credentialHashPath, readSecret = readSecretMuted, now = () => new Date() }) {
    if (!path.isAbsolute(checkpointPath) || !path.isAbsolute(credentialHashPath)) {
      throw new Error('Checkpoint and credential hash paths must be absolute.')
    }
    if (path.resolve(checkpointPath) === path.resolve(credentialHashPath)) {
      throw new Error('Checkpoint records and credential hashes must use separate files.')
    }
    this.checkpointPath = checkpointPath
    this.credentialHashPath = credentialHashPath
    this.readSecret = readSecret
    this.now = now
  }

  async captureCredentialHashes() {
    let username = await this.readSecret('Controlled username: ')
    let password = await this.readSecret('Controlled password: ')
    if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
      username = ''
      password = ''
      throw new Error('Controlled test credentials cannot be empty.')
    }
    const hashes = Object.freeze({ username: sha256(username), password: sha256(password) })
    username = ''
    password = ''
    const at = this.now()
    writeJsonAtomic(this.credentialHashPath, {
      schemaVersion: 1,
      capturedAt: at instanceof Date ? at.toISOString() : String(at),
      usernameSha256: hashes.username,
      passwordSha256: hashes.password
    })
    return hashes
  }

  confirm(id, confirmed, machineEvidenceId) {
    const checkpointId = safeIdentifier(id, 'Checkpoint ID')
    const evidenceId = machineEvidenceId === undefined ? undefined : safeIdentifier(machineEvidenceId, 'Machine evidence ID')
    const at = this.now()
    const record = Object.freeze({
      id: checkpointId,
      at: at instanceof Date ? at.toISOString() : String(at),
      confirmed: confirmed === true,
      machineEvidenceId: evidenceId,
      status: confirmed === true && evidenceId ? 'pass' : 'blocked'
    })
    fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true })
    fs.appendFileSync(this.checkpointPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
    return record
  }

  readAll() {
    if (!fs.existsSync(this.checkpointPath)) return []
    return fs.readFileSync(this.checkpointPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function confirmManualAutofill({ runRoot, runId, mode, operatorConfirmed }) {
  if (operatorConfirmed !== true) throw new Error('Explicit operator confirmation is required for manual autofill.')
  if (!['bitwarden', 'proton'].includes(mode)) throw new Error('Manual autofill confirmation requires an isolated gate.')
  if (fs.existsSync(path.join(runRoot, 'launcher.json')) || readJson(path.join(runRoot, 'status.json')).status !== 'stopped') {
    throw new Error('Manual autofill confirmation requires a stopped run.')
  }
  const command = readJson(path.join(runRoot, 'command.json'))
  const resultPath = path.join(runRoot, 'result.json')
  const result = readJson(resultPath)
  if (command.mode !== mode || command.runId !== runId || result.mode !== mode || result.runId !== runId ||
      result.status !== 'stopped' || typeof command.credentialReferenceSha256 !== 'string' ||
      command.credentialReferenceSha256 !== result.credentialReferenceSha256) {
    throw new Error('Stored run identity or credential reference is inconsistent.')
  }
  const definition = scenarioCatalog(mode).find((scenario) => scenario.id === 'manual-autofill')
  const scenario = result.scenarios?.[definition.id]
  if (!scenario || scenario.id !== definition.id || !['blocked', 'pass'].includes(scenario.status)) {
    throw new Error('Manual autofill scenario is not ready for confirmation.')
  }
  const evidence = (Array.isArray(result.fixtureEvidence) ? result.fixtureEvidence : [])
    .filter(controlledFixtureMatchEvidence)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0]
  if (!evidence) throw new Error('No matching controlled fixture evidence exists.')
  const artifactPath = path.join(runRoot, `${evidence.id}.json`)
  if (!fs.existsSync(artifactPath) || canonical(readJson(artifactPath)) !== canonical(evidence)) {
    throw new Error('Stored fixture evidence does not match its artifact.')
  }

  const store = new CheckpointStore({
    checkpointPath: path.join(runRoot, 'checkpoints.jsonl'),
    credentialHashPath: path.join(runRoot, 'unused-credential-hashes.json')
  })
  const existing = store.readAll().filter((record) => record.id === definition.checkpointId)
  if (existing.length > 1 || (existing.length === 1 &&
      (existing[0].confirmed !== true || existing[0].status !== 'pass' || existing[0].machineEvidenceId !== evidence.id))) {
    throw new Error('An incompatible manual autofill checkpoint already exists.')
  }
  const priorCheckpoint = result.checkpoints?.[definition.checkpointId]
  if (priorCheckpoint && (!existing[0] || canonical(priorCheckpoint) !== canonical(existing[0]))) {
    throw new Error('Stored manual autofill checkpoint conflicts with the append-only record.')
  }
  if (scenario.status === 'pass' && (!existing[0] ||
      scenario.checkpointId !== definition.checkpointId || !scenario.machineEvidence?.includes(evidence.id))) {
    throw new Error('Stored manual autofill scenario conflicts with fixture evidence.')
  }
  const checkpoint = existing[0] || store.confirm(definition.checkpointId, true, evidence.id)
  const nextScenario = scenario.status === 'pass' ? scenario : {
    ...scenario,
    status: 'pass',
    startedAt: evidence.observedAt,
    finishedAt: checkpoint.at,
    machineEvidence: [evidence.id]
  }
  writeJsonAtomic(resultPath, {
    ...result,
    scenarios: { ...result.scenarios, [definition.id]: nextScenario },
    checkpoints: { ...result.checkpoints, [definition.checkpointId]: checkpoint }
  })
  return { status: 'pass', scenario: definition.id, checkpointId: definition.checkpointId, evidenceId: evidence.id }
}

function confirmBitwardenSuggestion({ runRoot, runId, mode, operatorConfirmed }) {
  if (operatorConfirmed !== true) throw new Error('Explicit operator confirmation is required for the Bitwarden suggestion.')
  if (mode !== 'bitwarden') throw new Error('This suggestion checkpoint is specific to the isolated Bitwarden gate.')
  if (fs.existsSync(path.join(runRoot, 'launcher.json')) || readJson(path.join(runRoot, 'status.json')).status !== 'stopped') {
    throw new Error('Suggestion confirmation requires a stopped run.')
  }
  const command = readJson(path.join(runRoot, 'command.json'))
  const resultPath = path.join(runRoot, 'result.json')
  const result = readJson(resultPath)
  if (command.mode !== mode || command.runId !== runId || result.mode !== mode || result.runId !== runId ||
      result.status !== 'stopped' || typeof command.credentialReferenceSha256 !== 'string' ||
      command.credentialReferenceSha256 !== result.credentialReferenceSha256) {
    throw new Error('Stored run identity or credential reference is inconsistent.')
  }
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('The Bitwarden runtime ID is missing or invalid.')
  }
  const eventPath = path.join(runRoot, 'events.jsonl')
  const events = fs.readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const menuUrl = `chrome-extension://${extensionId}/overlay/menu-list.html`
  const candidates = []
  for (const event of events) {
    if (event.event !== 'target-created' || event.contextType !== 'iframe' || event.url !== menuUrl ||
        event.lifecycleState !== 'active' || !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) continue
    for (const fixture of result.fixtureEvidence || []) {
      if (!controlledFixtureMatchEvidence(fixture) || fixture.snapshot.fixture !== 'ordinary-login' ||
          new URL(fixture.snapshot.frameOrigin).hostname !== 'login.vast-test.local') continue
      const delay = Date.parse(fixture.observedAt) - Date.parse(event.at)
      if (delay >= 0 && delay <= 30_000) candidates.push({ event, fixture })
    }
  }
  candidates.sort((left, right) => Date.parse(right.fixture.observedAt) - Date.parse(left.fixture.observedAt))
  const selected = candidates[0]
  if (!selected) throw new Error('No Bitwarden inline-list lifecycle event is paired with a matching controlled fill.')
  const artifactPath = path.join(runRoot, `${selected.fixture.id}.json`)
  if (!fs.existsSync(artifactPath) || canonical(readJson(artifactPath)) !== canonical(selected.fixture)) {
    throw new Error('The matching fixture artifact is missing or inconsistent.')
  }
  const evidence = Object.freeze({
    id: 'suggestion-evidence-0',
    observedAt: selected.event.at,
    eventSequence: selected.event.sequence,
    extensionId,
    contextType: 'iframe',
    fixtureEvidenceId: selected.fixture.id
  })
  const suggestionPath = path.join(runRoot, `${evidence.id}.json`)
  if (fs.existsSync(suggestionPath) && canonical(readJson(suggestionPath)) !== canonical(evidence)) {
    throw new Error('An incompatible suggestion evidence artifact already exists.')
  }
  const priorEvidence = result.suggestionEvidence
  if (priorEvidence && canonical(priorEvidence) !== canonical(evidence)) {
    throw new Error('Stored suggestion evidence conflicts with the selected event.')
  }
  const definition = scenarioCatalog(mode).find((scenario) => scenario.id === 'credential-suggestion')
  const scenario = result.scenarios?.[definition.id]
  if (!scenario || !['blocked', 'pass'].includes(scenario.status)) throw new Error('Suggestion scenario is not ready for confirmation.')
  const store = new CheckpointStore({
    checkpointPath: path.join(runRoot, 'checkpoints.jsonl'),
    credentialHashPath: path.join(runRoot, 'unused-credential-hashes.json')
  })
  const existing = store.readAll().filter((record) => record.id === definition.checkpointId)
  if (existing.length > 1 || (existing.length === 1 &&
      (existing[0].confirmed !== true || existing[0].status !== 'pass' || existing[0].machineEvidenceId !== evidence.id))) {
    throw new Error('An incompatible suggestion checkpoint already exists.')
  }
  const previousCheckpoint = result.checkpoints?.[definition.checkpointId]
  if (previousCheckpoint && (!existing[0] || canonical(previousCheckpoint) !== canonical(existing[0]))) {
    throw new Error('Stored suggestion checkpoint conflicts with the append-only record.')
  }
  if (scenario.status === 'pass' && (!existing[0] || !scenario.machineEvidence?.includes(evidence.id))) {
    throw new Error('Stored suggestion scenario conflicts with its evidence.')
  }
  if (!fs.existsSync(suggestionPath)) writeJsonAtomic(suggestionPath, evidence)
  const checkpoint = existing[0] || store.confirm(definition.checkpointId, true, evidence.id)
  const nextScenario = scenario.status === 'pass' ? scenario : {
    ...scenario,
    status: 'pass',
    startedAt: evidence.observedAt,
    finishedAt: checkpoint.at,
    machineEvidence: [evidence.id]
  }
  writeJsonAtomic(resultPath, {
    ...result,
    suggestionEvidence: evidence,
    scenarios: { ...result.scenarios, [definition.id]: nextScenario },
    checkpoints: { ...result.checkpoints, [definition.checkpointId]: checkpoint }
  })
  return { status: 'pass', scenario: definition.id, checkpointId: definition.checkpointId, evidenceId: evidence.id }
}

function recordExtensionReload({ runRoot, runId, mode }) {
  if (mode !== 'bitwarden') throw new Error('Reload recording currently requires the isolated Bitwarden gate.')
  if (fs.existsSync(path.join(runRoot, 'launcher.json')) || readJson(path.join(runRoot, 'status.json')).status !== 'stopped') {
    throw new Error('Reload recording requires a stopped run.')
  }
  const command = readJson(path.join(runRoot, 'command.json'))
  const resultPath = path.join(runRoot, 'result.json')
  const result = readJson(resultPath)
  if (command.runId !== runId || command.mode !== mode || result.runId !== runId ||
      result.mode !== mode || result.status !== 'stopped') throw new Error('Stored reload run identity is inconsistent.')
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  const names = fs.readdirSync(runRoot).filter((name) => /^extension-reload-probe-\d+-[a-f0-9]{8}\.json$/.test(name))
  const successful = names.map((name) => ({ name, value: readJson(path.join(runRoot, name)) }))
    .filter(({ value }) => value?.outcome === 'reload-and-worker-recovered')
  if (successful.length !== 1) throw new Error('Exactly one successful extension reload artifact is required.')
  const { name, value } = successful[0]
  const allowed = ['apiOk', 'enabled', 'extensionId', 'identityPreserved', 'mode', 'observedAt',
    'outcome', 'privacyRecovered', 'runId', 'schemaVersion', 'workerRecreated']
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== allowed.sort().join(',') ||
      value.schemaVersion !== 1 || value.runId !== runId || value.mode !== mode ||
      value.extensionId !== extensionId || !/^[a-p]{32}$/.test(extensionId) ||
      typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) ||
      !['apiOk', 'identityPreserved', 'enabled', 'workerRecreated', 'privacyRecovered'].every((key) => value[key] === true)) {
    throw new Error('Reload artifact is incomplete or outside its safe schema.')
  }
  const evidence = { id: name.slice(0, -5), ...value }
  const priorEvidence = result.reloadEvidence
  if (priorEvidence && canonical(priorEvidence) !== canonical(evidence)) throw new Error('Stored reload evidence conflicts with artifact.')
  const scenario = result.scenarios?.['extension-reload']
  if (!scenario || !['blocked', 'pass'].includes(scenario.status)) throw new Error('Extension reload scenario is not ready.')
  if (scenario.status === 'pass' && !scenario.machineEvidence?.includes(evidence.id)) {
    throw new Error('Stored extension reload scenario conflicts with artifact.')
  }
  const nextScenario = scenario.status === 'pass' ? scenario : { ...scenario,
    status: 'pass', startedAt: evidence.observedAt, finishedAt: evidence.observedAt,
    machineEvidence: [evidence.id] }
  writeJsonAtomic(resultPath, { ...result, reloadEvidence: evidence,
    scenarios: { ...result.scenarios, 'extension-reload': nextScenario } })
  return { status: 'pass', scenario: 'extension-reload', evidenceId: evidence.id }
}

module.exports = { CheckpointStore, confirmBitwardenSuggestion, confirmManualAutofill, readSecretMuted, recordExtensionReload }
