import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  assignLikelyOwner,
  classifyMissingReceiver,
  classifyPopupTeardown
} = require('../../scripts/password-manager-gate/classify.cjs')

const EXTENSION_ID = 'nngceckbapebfimnlniiiahkandclblb'

function missingReceiverEvents(teardownEvent = 'recipient-destroyed') {
  return [
    { sequence: 10, event: teardownEvent, extensionId: EXTENSION_ID, targetId: 'target-1', tabId: 4, frameId: 0 },
    { sequence: 11, event: 'message-send', extensionId: EXTENSION_ID, targetId: 'target-1', tabId: 4, frameId: 0 },
    { sequence: 12, event: 'missing-receiver', extensionId: EXTENSION_ID, targetId: 'target-1', tabId: 4, frameId: 0, errorClass: 'NoReceiverError' }
  ]
}

const allRequiredOperationsPassed = {
  expectedRecipientLive: false,
  expectedLiveReplacement: false,
  requiredOperations: { fill: 'pass', popup: 'pass', save: 'pass' }
}

test('missing receiver is A only when destruction precedes send and no operation is lost', () => {
  for (const teardown of ['recipient-destroyed', 'recipient-navigated']) {
    const result = classifyMissingReceiver(missingReceiverEvents(teardown), allRequiredOperationsPassed)
    assert.equal(result.classification, 'A')
    assert.equal(result.functionalLoss, false)
    assert.ok(result.evidenceIds.length >= 2)
    assert.ok(result.reasons.some((reason: string) => /before the failed send/i.test(reason)))
  }
})

test('live expected recipient or any lost required operation is B', () => {
  const live = classifyMissingReceiver(missingReceiverEvents(), {
    ...allRequiredOperationsPassed,
    expectedRecipientLive: true
  })
  assert.equal(live.classification, 'B')
  assert.equal(live.functionalLoss, false)

  const lost = classifyMissingReceiver(missingReceiverEvents(), {
    expectedRecipientLive: false,
    expectedLiveReplacement: false,
    requiredOperations: { fill: 'fail', popup: 'pass' }
  })
  assert.equal(lost.classification, 'B')
  assert.equal(lost.functionalLoss, true)
})

test('incomplete, uncorrelated or out-of-order evidence cannot be called harmless', () => {
  assert.equal(classifyMissingReceiver([{ event: 'missing-receiver' }], {}).classification, 'unclassified')
  assert.equal(classifyMissingReceiver(missingReceiverEvents(), {
    requiredOperations: {},
    expectedRecipientLive: false,
    expectedLiveReplacement: false
  }).classification, 'unclassified')
  const wrongTarget = missingReceiverEvents()
  wrongTarget[0].targetId = 'other-target'
  assert.equal(classifyMissingReceiver(wrongTarget, allRequiredOperationsPassed).classification, 'unclassified')
  const wrongOrder = missingReceiverEvents()
  wrongOrder[0].sequence = 13
  assert.equal(classifyMissingReceiver(wrongOrder, allRequiredOperationsPassed).classification, 'unclassified')
})

test('live-recipient event is class B even when operation summary incorrectly claims teardown safety', () => {
  const baseline = missingReceiverEvents()
  baseline[2].sequence = 13
  const events = [baseline[0], baseline[1],
    { sequence: 12, event: 'recipient-live', extensionId: EXTENSION_ID, targetId: 'target-1', tabId: 4, frameId: 0 },
    baseline[2]]
  const result = classifyMissingReceiver(events, allRequiredOperationsPassed)
  assert.equal(result.classification, 'B')
  assert.ok(result.reasons.some((reason: string) => /live recipient/i.test(reason)))
})

function popupCycles(count = 20) {
  const events: Array<Record<string, unknown>> = []
  let sequence = 1
  for (let cycle = 1; cycle <= count; cycle += 1) {
    const targetId = `popup-${cycle}`
    for (const event of ['popup-did-attach', 'target-created', 'popup-destroyed', 'popup-detached', 'invalid-guest-instance-id']) {
      events.push({ sequence: sequence++, event, extensionId: EXTENSION_ID, targetId, contextType: 'popup' })
    }
  }
  return events
}

const healthyPopupEvidence = {
  successfulCycles: 20,
  subsequentPopup: 'pass',
  crash: false,
  leakedTargets: 0,
  leakedProcesses: 0,
  stuckPopup: false
}

test('popup teardown warning is A only after twenty ordered successful cycles without impact', () => {
  const result = classifyPopupTeardown(popupCycles(), healthyPopupEvidence)
  assert.equal(result.classification, 'A')
  assert.equal(result.functionalLoss, false)
  assert.equal(result.evidenceIds.length, 20)
})

test('popup crash, leak, stuck UI or lost subsequent operation is class B', () => {
  for (const evidence of [
    { ...healthyPopupEvidence, crash: true },
    { ...healthyPopupEvidence, leakedTargets: 1 },
    { ...healthyPopupEvidence, leakedProcesses: 1 },
    { ...healthyPopupEvidence, stuckPopup: true },
    { ...healthyPopupEvidence, subsequentPopup: 'fail' }
  ]) {
    const result = classifyPopupTeardown(popupCycles(), evidence)
    assert.equal(result.classification, 'B')
    assert.equal(result.functionalLoss, true)
  }
})

test('nineteen cycles, missing lifecycle stages or wrong ordering remain unclassified', () => {
  assert.equal(classifyPopupTeardown(popupCycles(19), { ...healthyPopupEvidence, successfulCycles: 19 }).classification, 'unclassified')
  const missing = popupCycles()
  missing.splice(2, 1)
  assert.equal(classifyPopupTeardown(missing, healthyPopupEvidence).classification, 'unclassified')
  const outOfOrder = popupCycles()
  ;[outOfOrder[2].sequence, outOfOrder[3].sequence] = [outOfOrder[3].sequence, outOfOrder[2].sequence]
  assert.equal(classifyPopupTeardown(outOfOrder, healthyPopupEvidence).classification, 'unclassified')
})

test('ownership is assigned only from layer-specific evidence', () => {
  assert.deepEqual(assignLikelyOwner({ incorrectTabFrameMapping: true }), {
    owner: 'vast', reasons: ['Vast produced an incorrect tab, frame or webContents mapping.']
  })
  assert.equal(assignLikelyOwner({ validRouteEnteredEce: true, routeLostInsideEce: true }).owner, 'ece')
  assert.equal(assignLikelyOwner({ reproducedPatchedElectron: true, reproducedUnmodifiedElectron: false }).owner, 'patched-electron')
  assert.equal(assignLikelyOwner({ reproducedUnmodifiedElectron: true }).owner, 'upstream-electron')
  assert.equal(assignLikelyOwner({ targetDestroyedBeforeSend: true, chromeMatches: true }).owner, 'bitwarden')
  assert.equal(assignLikelyOwner({ targetDestroyedBeforeSend: true }).owner, 'unknown')
})

test('conflicting ownership signals return unknown instead of guessing', () => {
  const result = assignLikelyOwner({
    incorrectTabFrameMapping: true,
    validRouteEnteredEce: true,
    routeLostInsideEce: true
  })
  assert.equal(result.owner, 'unknown')
  assert.ok(result.reasons.some((reason: string) => /conflicting/i.test(reason)))
})
