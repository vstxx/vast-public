import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const addressBarSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const constantsSource = readFileSync(new URL('../../src/shared/constants.ts', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../../src/renderer/store/browser-store.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/shared/types.ts', import.meta.url), 'utf8')

test('default settings persist per-site override disabled flags', () => {
  assert.match(typesSource, /siteOverrides:\s*\{\s*disabled:\s*Record<string,\s*boolean>/)
  assert.match(constantsSource, /siteOverrides:\s*\{\s*disabled:\s*\{\s*\}\s*\}/)
  assert.match(storeSource, /const siteOverrides = \{\s*\.\.\.state\.settings\.siteOverrides/)
  assert.match(storeSource, /siteOverrides\?:\s*Partial<BrowserSettings\['siteOverrides'\]>/)
})

test('address bar shows a subtle IDU skin toggle only for matching site overrides', () => {
  assert.match(addressBarSource, /Paintbrush/)
  assert.match(addressBarSource, /siteOverrideForUrl/)
  assert.match(addressBarSource, /activeSiteOverride/)
  assert.match(addressBarSource, /activeSiteOverride && \(/)
  assert.match(addressBarSource, /tooltip=\{siteOverrideDisabled \? 'Enable IDU skin' : 'Disable IDU skin'\}/)
  assert.match(addressBarSource, /active=\{!siteOverrideDisabled\}/)
  assert.match(addressBarSource, /updateSettings\(\{\s*siteOverrides:/)
})

test('webview applies or removes site override scripts from the existing dom-ready lifecycle', () => {
  assert.match(browserStageSource, /buildSiteOverrideScript/)
  assert.match(browserStageSource, /siteOverrideForUrl/)
  assert.match(browserStageSource, /applySiteOverride/)
  assert.match(browserStageSource, /onDomReady[\s\S]*applySiteOverride\(\)/)
  assert.match(browserStageSource, /settings\.siteOverrides/)
})

test('IDU skin injects bundled Inter font into third-party webviews', () => {
  assert.match(browserStageSource, /InterDisplay-Regular\.woff2\?url/)
  assert.match(browserStageSource, /InterDisplay-SemiBold\.woff2\?url/)
  assert.match(browserStageSource, /siteOverrideFontCss/)
  assert.match(browserStageSource, /data:font\/woff2;base64/)
  assert.match(browserStageSource, /buildSiteOverrideScript\(override,\s*enabled,\s*fontCss\)/)
})
