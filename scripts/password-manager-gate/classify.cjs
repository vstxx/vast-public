const CLASSIFICATIONS = Object.freeze(['A', 'B', 'unclassified'])

function result(classification, functionalLoss, reasons, evidenceIds) {
  if (!CLASSIFICATIONS.includes(classification)) throw new Error(`Invalid classification: ${classification}`)
  return Object.freeze({
    classification,
    functionalLoss,
    reasons: Object.freeze([...reasons]),
    evidenceIds: Object.freeze([...new Set(evidenceIds)])
  })
}

function evidenceId(event) {
  return Number.isFinite(event?.sequence) ? `sequence:${event.sequence}` : undefined
}

function sameRecipient(left, right) {
  return typeof left?.targetId === 'string' && left.targetId === right?.targetId &&
    typeof left?.extensionId === 'string' && left.extensionId === right?.extensionId &&
    Number.isSafeInteger(left?.tabId) && left.tabId === right?.tabId &&
    Number.isSafeInteger(left?.frameId) && left.frameId === right?.frameId
}

function operationState(operationEvidence) {
  const operations = operationEvidence?.requiredOperations
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) return { complete: false, lost: false }
  const values = Object.values(operations)
  if (values.length === 0) return { complete: false, lost: false }
  return {
    lost: values.some((value) => value === 'fail'),
    complete: values.every((value) => value === 'pass')
  }
}

function classifyMissingReceiver(events, operationEvidence = {}) {
  const ordered = Array.isArray(events) ? events.filter((event) => event && typeof event === 'object') : []
  const operations = operationState(operationEvidence)
  const warning = ordered.find((event) => event.event === 'missing-receiver')
  const ids = warning ? [evidenceId(warning)].filter(Boolean) : []

  if (operations.lost) {
    return result('B', true, ['A correlated required operation was lost.'], ids)
  }
  if (operationEvidence.expectedRecipientLive === true) {
    return result('B', false, ['The operation expected a live recipient when delivery failed.'], ids)
  }
  if (!warning || !Number.isFinite(warning.sequence)) {
    return result('unclassified', false, ['The missing-receiver warning lacks ordered reproduction evidence.'], ids)
  }

  const live = ordered.find((event) =>
    event.event === 'recipient-live' &&
    Number.isFinite(event.sequence) && event.sequence < warning.sequence &&
    sameRecipient(event, warning))
  if (live) {
    return result('B', false, ['A live recipient existed when message delivery failed.'], [evidenceId(live), ...ids].filter(Boolean))
  }

  const send = ordered.find((event) =>
    event.event === 'message-send' &&
    Number.isFinite(event.sequence) && event.sequence < warning.sequence &&
    sameRecipient(event, warning))
  const teardown = send && ordered.find((event) =>
    (event.event === 'recipient-destroyed' || event.event === 'recipient-navigated') &&
    Number.isFinite(event.sequence) && event.sequence < send.sequence &&
    sameRecipient(event, warning))

  const replacementProvenAbsent = operationEvidence.expectedLiveReplacement === false
  if (teardown && send && replacementProvenAbsent && operations.complete) {
    return result('A', false, [
      'The correlated recipient was destroyed or navigated before the failed send.',
      'No live replacement was expected and every correlated required operation passed.'
    ], [evidenceId(teardown), evidenceId(send), ...ids].filter(Boolean))
  }
  return result('unclassified', false, [
    'Evidence does not prove both a teardown-before-send race and preservation of every required operation.'
  ], [evidenceId(teardown), evidenceId(send), ...ids].filter(Boolean))
}

const POPUP_SEQUENCE = Object.freeze([
  'popup-did-attach',
  'target-created',
  'popup-destroyed',
  'popup-detached',
  'invalid-guest-instance-id'
])

function completePopupCycles(events) {
  const groups = new Map()
  for (const event of events) {
    if (!event || event.contextType !== 'popup' || typeof event.targetId !== 'string' || !POPUP_SEQUENCE.includes(event.event)) continue
    if (!groups.has(event.targetId)) groups.set(event.targetId, [])
    groups.get(event.targetId).push(event)
  }
  const cycles = []
  for (const [targetId, group] of groups) {
    const sorted = [...group].sort((left, right) => left.sequence - right.sequence)
    if (sorted.length !== POPUP_SEQUENCE.length) continue
    if (!sorted.every((event, index) => Number.isFinite(event.sequence) && event.event === POPUP_SEQUENCE[index])) continue
    cycles.push({ targetId, warning: sorted.at(-1) })
  }
  return cycles
}

function classifyPopupTeardown(events, operationEvidence = {}) {
  const ordered = Array.isArray(events) ? events : []
  const warnings = ordered.filter((event) => event?.event === 'invalid-guest-instance-id')
  const ids = warnings.map(evidenceId).filter(Boolean)
  const crash = operationEvidence.crash === true
  const leaked = Number(operationEvidence.leakedTargets) > 0 || Number(operationEvidence.leakedProcesses) > 0
  const stuck = operationEvidence.stuckPopup === true
  const lostSubsequent = operationEvidence.subsequentPopup === 'fail'
  if (crash || leaked || stuck || lostSubsequent) {
    const reasons = []
    if (crash) reasons.push('A popup cycle crashed the browser or extension process.')
    if (leaked) reasons.push('Popup teardown leaked a target or process.')
    if (stuck) reasons.push('A popup remained stuck after teardown.')
    if (lostSubsequent) reasons.push('A subsequent popup operation was lost.')
    return result('B', true, reasons, ids)
  }

  const cycles = completePopupCycles(ordered)
  const impactEvidenceComplete = operationEvidence.crash === false &&
    operationEvidence.leakedTargets === 0 && operationEvidence.leakedProcesses === 0 &&
    operationEvidence.stuckPopup === false && operationEvidence.subsequentPopup === 'pass'
  if (cycles.length >= 20 && operationEvidence.successfulCycles >= 20 && impactEvidenceComplete) {
    return result('A', false, [
      'At least twenty popup cycles completed with ordered attach, target, destroy, detach and exception evidence.',
      'No crash, leak, stuck popup or lost subsequent popup operation was observed.'
    ], cycles.slice(0, 20).map((cycle) => evidenceId(cycle.warning)).filter(Boolean))
  }
  return result('unclassified', false, [
    'Popup evidence is incomplete or fewer than twenty ordered successful cycles were proven.'
  ], ids)
}

function assignLikelyOwner(evidence = {}) {
  const candidates = []
  if (evidence.incorrectTabFrameMapping === true) {
    candidates.push({ owner: 'vast', reason: 'Vast produced an incorrect tab, frame or webContents mapping.' })
  }
  if (evidence.validRouteEnteredEce === true && evidence.routeLostInsideEce === true) {
    candidates.push({ owner: 'ece', reason: 'A valid route entered ECE and was lost inside its bridge.' })
  }
  if (evidence.reproducedPatchedElectron === true && evidence.reproducedUnmodifiedElectron === false) {
    candidates.push({ owner: 'patched-electron', reason: 'The behavior reproduces only with the accepted Electron patchset.' })
  }
  if (evidence.reproducedUnmodifiedElectron === true) {
    candidates.push({ owner: 'upstream-electron', reason: 'The behavior reproduces on the exact unmodified Electron base.' })
  }
  if (evidence.targetDestroyedBeforeSend === true && evidence.chromeMatches === true) {
    candidates.push({ owner: 'bitwarden', reason: 'Bitwarden targets an already-destroyed recipient in the same way under Chrome.' })
  }
  if (candidates.length === 1) {
    return Object.freeze({ owner: candidates[0].owner, reasons: Object.freeze([candidates[0].reason]) })
  }
  if (candidates.length > 1) {
    return Object.freeze({
      owner: 'unknown',
      reasons: Object.freeze(['Conflicting layer-specific ownership signals require more evidence.'])
    })
  }
  return Object.freeze({
    owner: 'unknown',
    reasons: Object.freeze(['Available evidence does not isolate the responsible layer.'])
  })
}

module.exports = { assignLikelyOwner, classifyMissingReceiver, classifyPopupTeardown }
