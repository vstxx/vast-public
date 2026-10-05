const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const file = path.join(__dirname, '../../scripts/guest-scroll-profile.cjs')
const profile = fs.existsSync(file) ? require(file) : {}

test('disposable benchmark profile opens its fixture instead of onboarding', () => {
  assert.equal(typeof profile.seedBenchmarkProfile, 'function')
  const original = {
    activeWorkspaceId: 'work',
    onboarding: { completed: false },
    workspaces: [{ id: 'work', isPrivate: false, activeTabId: 'old' }],
    tabs: [],
    settings: { openingAnimation: true, hibernateInactiveTabs: true }
  }
  const seeded = profile.seedBenchmarkProfile(original, 'http://127.0.0.1:1234/fixture/text', 100)
  assert.equal(seeded.onboarding.completed, true)
  assert.equal(seeded.workspaces[0].activeTabId, 'benchmark-tab')
  assert.equal(seeded.tabs[0].url, 'http://127.0.0.1:1234/fixture/text')
  assert.equal(seeded.tabs[0].lifecycle, 'active')
  assert.equal(seeded.settings.hibernateInactiveTabs, false)
  assert.equal(original.onboarding.completed, false)
})
