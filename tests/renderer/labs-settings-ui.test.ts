import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const internalRouterSource = readFileSync(new URL('../../src/renderer/components/browser/InternalPageRouter.tsx', import.meta.url), 'utf8')

test('settings always expose Labs with only feature-specific controls', () => {
  assert.match(settingsSource, /section id="Labs"/)
  assert.doesNotMatch(settingsSource, /Enable Vast Labs/)
  for (const label of ['Video & Audio', 'Network Devices', 'Automation', 'Password Manager', 'Diagnostics', 'Spoofing']) {
    assert.match(settingsSource, new RegExp(`label="${label}"`))
  }
  assert.doesNotMatch(settingsSource, /local, experimental programs/)
  assert.doesNotMatch(settingsSource, /memory budget for the app shell|Active probing only checks|Unsafe protocols stay blocked|This identity has its own cookies/)
})

test('Labs toggles block only coming-soon features', () => {
  assert.match(settingsSource, /const locked = state\.state === 'ComingSoon'/)
  assert.doesNotMatch(settingsSource, /LockedFree|vastProUpgradePanel|Activate Pro|Upgrade/)
})

test('internal pages render local feature gates before Labs pages', () => {
  assert.match(internalRouterSource, /featureGateForInternalUrl/)
  assert.match(internalRouterSource, /getFeatureStateForGate\(gate, \{ settings: featureContextSettings \}\)/)
  assert.match(internalRouterSource, /FeatureGatePage/)
  assert.doesNotMatch(internalRouterSource, /LicenseStatus|paidFeature|recoveryMode/)
})
