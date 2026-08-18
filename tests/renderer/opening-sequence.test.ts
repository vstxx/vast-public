import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'
import { OPENING_AUDIO, OPENING_SEQUENCE, openingVolumeToGain } from '../../src/renderer/app/opening-sequence.ts'

test('opening sequence fits the approved five-second launch timeline', () => {
  assert.equal(OPENING_SEQUENCE.totalMs, 5_000)
  assert.equal(OPENING_SEQUENCE.backgroundFadeInEndMs, 400)
  assert.equal(OPENING_SEQUENCE.logoVisibleByMs, 1_100)
  assert.equal(OPENING_SEQUENCE.calmPresenceEndMs, 3_300)
  assert.equal(OPENING_SEQUENCE.chromeRevealEndMs, 4_600)
  assert.equal(OPENING_SEQUENCE.overlayHideMs, 5_000)
})

test('opening audio resolves inside the same launch window', () => {
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
  assert.ok(OPENING_AUDIO.voices.every((voice) => voice.startMs <= OPENING_SEQUENCE.backgroundFadeInEndMs))
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
