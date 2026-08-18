import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const constantsSource = readFileSync(new URL('../../src/shared/constants.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const sessionSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

function cssBlock(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesSource.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))
  assert.ok(match, `Expected to find ${selector} block`)
  return match[0]
}

test('website forced dark mode defaults off', () => {
  assert.match(constantsSource, /forceDarkModeWebsites:\s*false/)
})

test('main process does not force website dark mode unless setting is enabled', () => {
  assert.match(mainSource, /forceDarkModeWebsites/)
  assert.match(mainSource, /websiteDarkModeEnabled/)
  assert.match(mainSource, /nativeTheme\.themeSource = nativeThemeSource/)
  assert.doesNotMatch(mainSource, /nativeTheme\.themeSource = websiteThemeSource/)
})

test('website dark mode off does not force native theme to light', () => {
  assert.doesNotMatch(mainSource, /if \(!settings\.appearance\.forceDarkModeWebsites\) return 'light'/)
})

test('appearance settings expose website dark mode toggle', () => {
  assert.match(settingsSource, /Force dark mode on websites/)
})

test('Vast theme does not paint website webview backgrounds', () => {
  const webviewBlock = cssBlock('.browser-webview')
  assert.match(webviewBlock, /background:\s*#fff/)
  assert.doesNotMatch(webviewBlock, /background:\s*transparent/)
  assert.doesNotMatch(stylesSource, /\.light-theme\s+\.browser-webview/)
  assert.doesNotMatch(stylesSource, /\.dim-theme\s+\.browser-webview/)
})

test('webviews use an opaque normal browser canvas instead of Vast theme transparency', () => {
  assert.match(webviewSurfaceSource, /webpreferences="transparent=no"/)
  assert.match(sessionSource, /webPreferences\.transparent = false/)
})
