import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OPENING_STARTUP_HANDLED_QUERY_PARAM,
  OPENING_STARTUP_QUERY_PARAM,
  OPENING_STARTUP_VOLUME_QUERY_PARAM,
  isOpeningAnimationEnabled,
  normalizeOpeningSoundVolume,
  parseOpeningHandledStartupFlag,
  parseOpeningHandledStartupSearch,
  parseOpeningStartupFlag,
  parseOpeningStartupSearch,
  parseOpeningStartupVolumeFlag,
  parseOpeningStartupVolumeSearch,
  serializeOpeningHandledStartupFlag,
  serializeOpeningStartupFlag,
  serializeOpeningStartupQuery,
  serializeOpeningStartupVolumeFlag
} from '../../src/shared/opening-startup.ts'

test('serializes an enabled startup flag when opening animation should start immediately', () => {
  const flag = serializeOpeningStartupFlag({
    animations: true,
    openingAnimation: true
  })

  assert.equal(flag, '--vast-opening-startup=1')
})

test('serializes the startup sound volume for preload', () => {
  const flag = serializeOpeningStartupVolumeFlag({
    openingAnimationSoundVolume: 85
  })

  assert.equal(flag, '--vast-opening-volume=85')
})

test('serializes whether an external splash already handled the opening animation', () => {
  assert.equal(serializeOpeningHandledStartupFlag(true), '--vast-opening-handled=1')
  assert.equal(serializeOpeningHandledStartupFlag(false), '--vast-opening-handled=0')
  assert.equal(parseOpeningHandledStartupFlag(['electron', '--vast-opening-handled=1']), true)
  assert.equal(parseOpeningHandledStartupFlag(['electron', '--vast-opening-handled=0']), false)
  assert.equal(parseOpeningHandledStartupSearch('?vastOpeningHandled=1'), true)
  assert.equal(parseOpeningHandledStartupSearch('?vastOpeningHandled=0'), false)
})

test('serializes a disabled startup flag when opening animation should not start immediately', () => {
  const flag = serializeOpeningStartupFlag({
    animations: true,
    openingAnimation: false
  })

  assert.equal(flag, '--vast-opening-startup=0')
})

test('parses the startup flag from renderer argv', () => {
  assert.equal(parseOpeningStartupFlag(['electron', '--vast-opening-startup=1']), true)
  assert.equal(parseOpeningStartupFlag(['electron', '--vast-opening-startup=0']), false)
  assert.equal(parseOpeningStartupFlag(['electron']), false)
})

test('serializes and parses the startup query for the first renderer document', () => {
  const enabled = serializeOpeningStartupQuery({ animations: true, openingAnimation: true, openingAnimationSoundVolume: 85 })
  const disabled = serializeOpeningStartupQuery({ animations: true, openingAnimation: false, openingAnimationSoundVolume: 35 }, true)

  assert.deepEqual(enabled, {
    [OPENING_STARTUP_QUERY_PARAM]: '1',
    [OPENING_STARTUP_VOLUME_QUERY_PARAM]: '85',
    [OPENING_STARTUP_HANDLED_QUERY_PARAM]: '0'
  })
  assert.deepEqual(disabled, {
    [OPENING_STARTUP_QUERY_PARAM]: '0',
    [OPENING_STARTUP_VOLUME_QUERY_PARAM]: '35',
    [OPENING_STARTUP_HANDLED_QUERY_PARAM]: '1'
  })
  assert.equal(parseOpeningStartupSearch(`?${OPENING_STARTUP_QUERY_PARAM}=1`), true)
  assert.equal(parseOpeningStartupSearch(`?${OPENING_STARTUP_QUERY_PARAM}=0`), false)
  assert.equal(parseOpeningStartupSearch(''), false)
})

test('parses and clamps startup sound volume', () => {
  assert.equal(parseOpeningStartupVolumeFlag(['electron', '--vast-opening-volume=72']), 72)
  assert.equal(parseOpeningStartupVolumeSearch('?vastOpeningVolume=140'), 100)
  assert.equal(parseOpeningStartupVolumeSearch('?vastOpeningVolume=-8'), 0)
  assert.equal(parseOpeningStartupVolumeSearch('', 64), 64)
  assert.equal(normalizeOpeningSoundVolume(Number.NaN), 85)
})

test('opening animation enablement requires both animation settings', () => {
  assert.equal(isOpeningAnimationEnabled({ animations: true, openingAnimation: true }), true)
  assert.equal(isOpeningAnimationEnabled({ animations: true, openingAnimation: false }), false)
  assert.equal(isOpeningAnimationEnabled({ animations: false, openingAnimation: true }), false)
})
