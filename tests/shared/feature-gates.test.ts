import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { resolveLocalFeatureState } from '../../src/shared/local-feature-state.ts'

const source = readFileSync(new URL('../../src/shared/feature-gates.ts', import.meta.url), 'utf8')

test('local feature resolver exposes only available, disabled-by-flag, and coming-soon states', () => {
  assert.equal(resolveLocalFeatureState({ comingSoon: false, labRequired: false, labsEnabled: false, featureEnabled: false }), 'Available')
  assert.equal(resolveLocalFeatureState({ comingSoon: false, labRequired: true, labsEnabled: false, featureEnabled: true }), 'Available')
  assert.equal(resolveLocalFeatureState({ comingSoon: false, labRequired: true, labsEnabled: true, featureEnabled: false }), 'DisabledByFlag')
  assert.equal(resolveLocalFeatureState({ comingSoon: false, labRequired: true, labsEnabled: true, featureEnabled: true }), 'Available')
  assert.equal(resolveLocalFeatureState({ comingSoon: true, labRequired: false, labsEnabled: true, featureEnabled: true }), 'ComingSoon')
})

test('feature states contain no product-license state or paid metadata', () => {
  assert.doesNotMatch(source, /LockedFree|paidFeature|upgradeMessage|LicenseStatus/)
  assert.match(source, /FeatureStateKind = LocalFeatureStateKind/)
})

test('normally available features have no Labs flag', () => {
  for (const feature of ['AdvancedNotes', 'SessionTimeline', 'AdvancedImportExport', 'MultipleWorkspaces']) {
    const start = source.indexOf(`[VastFeatures.${feature}]`)
    const end = source.indexOf('\n  [VastFeatures.', start + 1)
    const entry = source.slice(start, end < 0 ? undefined : end)
    assert.ok(start >= 0, `${feature} registry entry is missing`)
    assert.doesNotMatch(entry, /\blab:/)
  }
})

test('all experimental runtime features retain their local Labs flags', () => {
  for (const flag of ['avidae', 'networkDevices', 'automation', 'passwordManager', 'advancedDiagnostics', 'spoofing']) {
    assert.match(source, new RegExp(`lab: '${flag}'`))
  }
  assert.match(source, /settings\.labs\?\.\[gate\.lab\] === true/)
  assert.doesNotMatch(source, /settings\.labs\?\.enabled &&/)
})

test('Experimental Themes is neutral and remains coming soon', () => {
  assert.match(source, /ExperimentalThemes: 'experimental-themes'/)
  assert.match(source, /label: 'Experimental themes'/)
  assert.match(source, /comingSoon: true/)
})
