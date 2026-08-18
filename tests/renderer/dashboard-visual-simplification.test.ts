import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const dashboardSource = readFileSync(new URL('../../src/renderer/components/new-tab/NewTabPage.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')

test('dashboard surfaces use restrained solid backgrounds instead of stacked decorative gradients', () => {
  assert.match(dashboardSource, /min-h-full overflow-auto bg-vast-bg/)
  assert.match(dashboardSource, /bg-\[#090a0e\]/)
  assert.doesNotMatch(dashboardSource, /vast-hero-aura/)
  assert.doesNotMatch(dashboardSource, /bg-\[radial-gradient/)
})

test('search-only new tab removes every descendant gradient and shadow', () => {
  assert.match(dashboardSource, /new-tab-flat-search/)
  const ruleStart = stylesSource.indexOf('.new-tab-flat-search,')
  assert.notEqual(ruleStart, -1)
  const rule = stylesSource.slice(ruleStart, stylesSource.indexOf('}', ruleStart) + 1)
  assert.match(rule, /background-image: none !important/)
  assert.match(rule, /box-shadow: none !important/)
  assert.match(rule, /text-shadow: none !important/)
  assert.match(rule, /filter: none !important/)
  assert.match(rule, /backdrop-filter: none !important/)
})

test('the former product-upgrade page and route are absent', () => {
  assert.equal(existsSync(new URL('../../src/renderer/components/license/UpgradePage.tsx', import.meta.url)), false)
  assert.doesNotMatch(browserStageSource, /UpgradePage|vast:\/\/upgrade/)
})
