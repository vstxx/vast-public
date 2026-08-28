import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { catAddonEnabled, withBuildCapabilities } = require('../../scripts/build-capabilities.cjs') as {
  catAddonEnabled(env: Record<string, string>): boolean
  withBuildCapabilities(build: { extraResources?: Array<{ from: string; to: string }> }, env: Record<string, string>): { extraResources: Array<{ from: string; to: string }> }
}

test('Cat Addon capability defaults off for every public build and remains available in development', () => {
  assert.equal(catAddonEnabled({ VAST_RELEASE_CHANNEL: 'beta', VAST_PRIVATE_BUILD: '0' }), false)
  assert.equal(catAddonEnabled({ VAST_RELEASE_CHANNEL: 'stable', VAST_PRIVATE_BUILD: '0' }), false)
  assert.equal(catAddonEnabled({ VAST_RELEASE_CHANNEL: 'dev', VAST_PRIVATE_BUILD: '1' }), true)
  assert.equal(catAddonEnabled({ VAST_RELEASE_CHANNEL: 'dev', VAST_PRIVATE_BUILD: '1', VAST_CAT_ADDON_ENABLED: '0' }), false)
})

test('Cat Addon resources are attached only by the central capability', () => {
  const build = { extraResources: [{ from: 'resources/other', to: 'other' }, { from: 'stale-cat', to: 'cat-addon' }] }
  const disabled = withBuildCapabilities(build, { VAST_RELEASE_CHANNEL: 'beta', VAST_PRIVATE_BUILD: '0', VAST_CAT_ADDON_ENABLED: '0' })
  assert.deepEqual(disabled.extraResources, [{ from: 'resources/other', to: 'other' }])
  const enabled = withBuildCapabilities(build, { VAST_RELEASE_CHANNEL: 'dev', VAST_PRIVATE_BUILD: '1', VAST_CAT_ADDON_ENABLED: '1' })
  assert.deepEqual(enabled.extraResources.filter((item) => item.to === 'cat-addon'), [{ from: 'resources/cat-addon', to: 'cat-addon' }])
})

test('disabled Cat Addon skips source asset checks', () => {
  const source = readFileSync(new URL('../../scripts/build-app.cjs', import.meta.url), 'utf8')
  assert.match(source, /if \(catAddonEnabled\(process\.env\)\) run\('npm', \['run', 'cat-addon:check'\]\)/)
})

test('disabled Cat Addon is removed from the compiled main-process graph', () => {
  const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
  const serviceSource = readFileSync(new URL('../../src/main/cat-addon-service.ts', import.meta.url), 'utf8')
  const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
  const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
  const rendererEventsSource = readFileSync(new URL('../../src/renderer/lib/cat-addon-events.ts', import.meta.url), 'utf8')
  const packageVerifierSource = readFileSync(new URL('../../scripts/verify-release-package.cjs', import.meta.url), 'utf8')
  assert.match(mainSource, /__VAST_CAT_ADDON_AVAILABLE__ && buildMetadata\.catAddonAvailable/)
  assert.match(mainSource, /\}, \(\) => import\('\.\/cat-addon'\)\)/)
  assert.match(mainSource, /await import\('\.\/ipc\/cat-addon'\)/)
  assert.doesNotMatch(serviceSource, /ManagerLoader\s*=\s*\(\)\s*=>\s*import\('\.\/cat-addon'\)/)
  assert.doesNotMatch(ipcSource, /vast:cat-addon/)
  assert.match(preloadSource, /const catAddonApi = __VAST_CAT_ADDON_AVAILABLE__ \? \{/)
  assert.match(rendererEventsSource, /if \(!__VAST_CAT_ADDON_AVAILABLE__\) return/)
  assert.match(packageVerifierSource, /forbiddenBundledExtensionSource/)
  assert.match(packageVerifierSource, /packagedBuildMetadata\?\.catAddonIncluded === false/)
})
