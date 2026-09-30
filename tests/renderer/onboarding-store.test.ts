import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DATA, INTERNAL_NEW_TAB_URL, INTERNAL_ONBOARDING_URL } from '../../src/shared/constants.ts'
import { onboardingDefaultChoices, ONBOARDING_ACCENTS, ONBOARDING_RADIUS_MAX, ONBOARDING_RADIUS_MIN, onboardingCompleted } from '../../src/shared/onboarding.ts'
import type { PersistedData, Tab, Workspace } from '../../src/shared/types.ts'
import { applyOnboardingStart } from '../../src/renderer/store/onboarding-hydration.ts'

const workspace: Workspace = {
  id: 'workspace-default', name: 'Workspace', icon: 'Globe2', color: '#d1a3ff', order: 0,
  activeTabId: 'tab-1', createdAt: 1, updatedAt: 1
}

function restoredTab(id: string, url: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id, workspaceId: workspace.id, title: 'Tab', url, pinned: false, status: 'idle',
    lifecycle: 'active', progress: 0, canGoBack: false, canGoForward: false,
    zoom: 1, lastAccessedAt: 1, createdAt: 1, ...overrides
  }
}

function persistedWith(partial: Partial<PersistedData>): PersistedData {
  return { ...structuredClone(DEFAULT_DATA), ...partial }
}

test('onboarding defaults are sourced from DEFAULT_SETTINGS, never hardcoded', () => {
  const defaults = onboardingDefaultChoices()
  assert.equal(defaults.theme, DEFAULT_DATA.settings.theme)
  assert.equal(defaults.accentColor, DEFAULT_DATA.settings.accentColor)
  assert.equal(defaults.cornerRadius, DEFAULT_DATA.settings.appearance.cornerRadius)
  assert.equal(defaults.cleanToolbarIcons, true)
  assert.deepEqual(defaults.labs, DEFAULT_DATA.settings.labs)
  assert.equal(defaults.defaultSearchEngine, DEFAULT_DATA.settings.defaultSearchEngine)
  assert.equal(defaults.newTabBackground, DEFAULT_DATA.settings.newTab.background)
  assert.ok(ONBOARDING_RADIUS_MIN >= 6)
  assert.ok(ONBOARDING_RADIUS_MAX <= 36)
  assert.ok(ONBOARDING_ACCENTS.some((accent) => accent.value === DEFAULT_DATA.settings.accentColor))
})

test('onboardingCompleted reads the optional persisted field defensively', () => {
  assert.equal(onboardingCompleted({}), false)
  assert.equal(onboardingCompleted({ onboarding: { completed: false } }), false)
  assert.equal(onboardingCompleted({ onboarding: { completed: true } }), true)
})

test('a fresh profile routes its initial tab to vast://onboarding', () => {
  const data = persistedWith({ onboarding: { completed: false } })
  const tabs = data.tabs.map((tab) => ({ ...tab, id: 'tab-1' }))
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-1' }, onboardingCompleted: false })
  assert.equal(next.length, 1)
  assert.equal(next[0]?.url, INTERNAL_ONBOARDING_URL)
  assert.equal(next[0]?.title, 'Onboarding')
})

test('a completed profile is never sent through onboarding again', () => {
  const data = persistedWith({ onboarding: { completed: true } })
  const tabs = data.tabs.map((tab) => ({ ...tab, id: 'tab-1', url: INTERNAL_NEW_TAB_URL }))
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-1' }, onboardingCompleted: true })
  assert.equal(next[0]?.url, INTERNAL_NEW_TAB_URL)
})

test('completed onboarding recovers a tab left on setup if final navigation was interrupted', () => {
  const next = applyOnboardingStart([restoredTab('tab-1', INTERNAL_ONBOARDING_URL)], {
    activeWorkspace: workspace, onboardingCompleted: true
  })
  assert.equal(next[0]?.url, INTERNAL_NEW_TAB_URL)
})

test('an interrupted onboarding resumes on the onboarding tab, predictable and singular', () => {
  const tabs = [
    restoredTab('tab-1', 'https://github.com/'),
    restoredTab('tab-2', INTERNAL_ONBOARDING_URL),
    restoredTab('tab-3', 'https://example.com/')
  ]
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-3' }, onboardingCompleted: false })
  assert.equal(next.filter((tab) => tab.url === INTERNAL_ONBOARDING_URL).length, 1)
  assert.equal(next.find((tab) => tab.id === 'tab-1')?.url, 'https://github.com/')
  assert.equal(next.find((tab) => tab.id === 'tab-3')?.url, 'https://example.com/')
})

test('pinned active tabs are not hijacked for onboarding', () => {
  const tabs = [restoredTab('tab-1', 'https://github.com/', { pinned: true })]
  const next = applyOnboardingStart(tabs, { activeWorkspace: { ...workspace, activeTabId: 'tab-1' }, onboardingCompleted: false })
  assert.equal(next[0]?.url, 'https://github.com/')
})
