import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'
import { OPENING_AUDIO, OPENING_PRESENTATION, OPENING_SEQUENCE, openingVolumeToGain } from '../../src/shared/opening-sequence.ts'

test('opening sequence targets the 2-3 second parallel startup window', () => {
  assert.equal(OPENING_SEQUENCE.totalMs, 2_700)
  assert.equal(OPENING_SEQUENCE.backgroundFadeInEndMs, 250)
  assert.equal(OPENING_SEQUENCE.logoVisibleByMs, 1_000)
  assert.equal(OPENING_SEQUENCE.calmPresenceEndMs, 2_100)
  assert.equal(OPENING_SEQUENCE.exitBeginMs, 2_100)
  assert.ok(OPENING_SEQUENCE.totalMs >= 2_000 && OPENING_SEQUENCE.totalMs <= 3_000)
})

test('the timeline settles, reveals the logo, then holds a calm final state', () => {
  assert.ok(OPENING_SEQUENCE.backgroundFadeInEndMs < OPENING_SEQUENCE.logoVisibleByMs)
  assert.ok(OPENING_SEQUENCE.logoVisibleByMs < OPENING_SEQUENCE.calmPresenceEndMs)
  assert.equal(OPENING_SEQUENCE.calmPresenceEndMs, OPENING_SEQUENCE.exitBeginMs)
  assert.ok(OPENING_SEQUENCE.exitBeginMs < OPENING_SEQUENCE.totalMs)
})

test('presentation constants size the compact splash and gate failures', () => {
  assert.equal(OPENING_PRESENTATION.width, 680)
  assert.equal(OPENING_PRESENTATION.height, 400)
  assert.equal(OPENING_PRESENTATION.minimumWidth, 520)
  assert.equal(OPENING_PRESENTATION.minimumHeight, 320)
  assert.equal(OPENING_PRESENTATION.exitFadeMs, 180)
  assert.ok(OPENING_PRESENTATION.exitFadeSteps >= 4)
  assert.ok(OPENING_PRESENTATION.fallbackTimeoutMs > OPENING_SEQUENCE.totalMs * 3)
})

test('opening audio resolves inside the shorter launch window', () => {
  assert.equal(OPENING_AUDIO.durationMs, OPENING_SEQUENCE.totalMs)
  assert.ok(OPENING_AUDIO.masterPeakMs < OPENING_AUDIO.fadeOutStartMs)
  assert.ok(OPENING_AUDIO.fadeOutStartMs < OPENING_AUDIO.durationMs)
  assert.ok(OPENING_AUDIO.voices.every((voice) => voice.startMs < OPENING_AUDIO.durationMs))
  assert.ok(OPENING_AUDIO.voices.every((voice) => voice.releaseMs <= OPENING_AUDIO.durationMs))
})

test('opening audio blooms after the logo is readable, not before it', () => {
  assert.ok(OPENING_AUDIO.masterPeakMs > OPENING_SEQUENCE.logoVisibleByMs)
  assert.ok(OPENING_AUDIO.masterPeakMs <= OPENING_SEQUENCE.logoVisibleByMs + 360)
  assert.ok(OPENING_AUDIO.filterPeakMs <= OPENING_SEQUENCE.logoVisibleByMs + 620)
  assert.ok(OPENING_AUDIO.noisePeakMs > OPENING_SEQUENCE.backgroundFadeInEndMs)
  assert.ok(OPENING_AUDIO.noisePeakMs <= OPENING_SEQUENCE.logoVisibleByMs + 260)
  assert.ok(OPENING_AUDIO.voices.every((voice) => voice.startMs <= OPENING_SEQUENCE.logoVisibleByMs))
  assert.ok(OPENING_AUDIO.voices.every((voice) => voice.attackMs >= 620 && voice.attackMs <= 860))
})

test('opening audio has a louder default volume and clamps gain scaling', () => {
  assert.equal(DEFAULT_SETTINGS.openingAnimationSoundVolume, OPENING_AUDIO.defaultVolume)
  assert.equal(OPENING_AUDIO.maxGainScale, 5.5)
  assert.equal(openingVolumeToGain(-10), 0)
  assert.equal(openingVolumeToGain(0), 0)
  assert.equal(openingVolumeToGain(OPENING_AUDIO.defaultVolume), 0)
  assert.equal(openingVolumeToGain(50), OPENING_AUDIO.maxGainScale / 2)
  assert.equal(openingVolumeToGain(100), OPENING_AUDIO.maxGainScale)
  assert.equal(openingVolumeToGain(120), OPENING_AUDIO.maxGainScale)
})
