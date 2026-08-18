import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAT_SCENE_SIZE,
  catBottomY,
  catChromeY,
  catClimbStartY,
  catRailY,
  clampCatY,
  isHorizontalCatRail
} from '../../src/renderer/components/cat-addon/cat-layout.ts'

test('top chrome scenes remain fully discoverable inside the viewport', () => {
  const tabStrip = { left: 0, top: 0, width: 1_600, height: 48 }
  const omnibox = { left: 220, top: 49, width: 1_100, height: 64 }
  assert.equal(isHorizontalCatRail(tabStrip), true)
  assert.equal(catRailY(tabStrip, 1_000), 20)
  assert.equal(catChromeY(omnibox, 1_000), 85)
  assert.ok(catChromeY(omnibox, 1_000) >= 6)
})

test('vertical rail and climb scenes use visible positions instead of negative top-bar coordinates', () => {
  const verticalRail = { left: 0, top: 70, width: 288, height: 830 }
  const perch = catRailY(verticalRail, 1_000)
  assert.equal(isHorizontalCatRail(verticalRail), false)
  assert.ok(perch > 300 && perch < 700)
  assert.ok(catClimbStartY(perch, 1_000) > perch)
})

test('scene coordinates are clamped while the bottom runner keeps its feet on screen', () => {
  assert.equal(clampCatY(-52, 900), 6)
  assert.equal(catBottomY(900), 900 - CAT_SCENE_SIZE + 8)
  assert.equal(clampCatY(9_000, 900), catBottomY(900))
})
