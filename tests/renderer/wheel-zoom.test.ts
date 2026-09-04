import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const stageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const webviewSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const guestPreloadSource = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')

test('Ctrl+wheel crosses the webview boundary and targets the hovered external tab', () => {
  assert.match(guestPreloadSource, /event\.preventDefault\(\)[\s\S]*event\.deltaMode === 1[\s\S]*sendToHost\('vast:wheel-zoom', event\.deltaY \* scale\)/)
  assert.match(guestPreloadSource, /addEventListener\('wheel', onZoomWheel, \{ capture: true, passive: false \}\)/)
  assert.match(webviewSource, /message\.channel === 'vast:wheel-zoom'/)
  assert.match(webviewSource, /runtime\.adjustZoom\([^\n]+, tab\.id\)/)
  assert.doesNotMatch(webviewSource, /HTMLElement\)\.addEventListener\('wheel'/)
})

test('Ctrl+wheel zooms the hovered internal pane and applies its stored zoom', () => {
  assert.match(appSource, /event\.composedPath\(\)[\s\S]*item\.dataset\.tabId/)
  assert.match(appSource, /runtime\.adjustZoom\([^\n]+pane\?\.dataset\.tabId\)/)
  assert.match(stageSource, /className="internal-page-zoom-surface"/)
  assert.match(stageSource, /width: `\$\{100 \/ tab\.zoom\}%`/)
  assert.match(stageSource, /transform: `scale\(\$\{tab\.zoom\}\)`/)
  assert.match(stageSource, /transformOrigin: 'top left'/)
  assert.doesNotMatch(stageSource, /zoom: tab\.zoom/)
  assert.match(stylesSource, /\.internal-page-zoom-surface\s*\{[^}]*position:\s*absolute[^}]*overflow:\s*auto/s)
})
