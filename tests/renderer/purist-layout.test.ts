import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const puristSource = readFileSync(new URL('../../src/renderer/components/purist/PuristChrome.tsx', import.meta.url), 'utf8')
const horizontalSource = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8')
const addressSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')
const globalStylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const puristStylesSource = readFileSync(new URL('../../src/renderer/components/purist/purist.css', import.meta.url), 'utf8')
const stylesSource = `${globalStylesSource}\n${puristStylesSource}`
const windowControlsSource = readFileSync(new URL('../../src/renderer/components/window/WindowControls.tsx', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const browserRuntimeSource = `${browserStageSource}\n${webviewSurfaceSource}`
const guestPreloadSource = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')

test('Purist composes the shared browser flows inside a dedicated chrome', () => {
  assert.match(puristSource, /export function PuristChrome/)
  assert.match(puristSource, /<WorkspacePopover[\s\S]*variant="purist"/)
  assert.match(puristSource, /<AddressBar compact variant="purist"/)
  assert.match(puristSource, /<BookmarksBar variant="purist" \/>/)
  assert.match(addressSource, /variant\?: 'default' \| 'purist'/)
  assert.match(horizontalSource, /export function WorkspacePopover/)
  assert.match(horizontalSource, /export function BookmarksBar/)
})

test('Purist tabs remain functional when the strip overflows', () => {
  assert.match(puristSource, /role="tablist"/)
  assert.match(puristSource, /overflow-x-auto overflow-y-hidden/)
  assert.match(puristSource, /scrollBy\(\{ left: event\.deltaY, behavior: 'smooth' \}\)/)
  assert.match(puristSource, /scrollIntoView\(\{ behavior: 'smooth'/)
  assert.match(puristSource, /\.filter\(\(tab\) => tab\.pinned\)/)
  assert.match(puristSource, /useTabMotion<HTMLDivElement>\(tab\.id\)/)
  assert.match(puristSource, /moveTab\(draggedId, targetId\)/)
  assert.match(puristSource, /window\.vast\.browser\.detachTab\(payload\)/)
  assert.match(puristSource, /openTabContextMenu\(tab, event\.clientX, event\.clientY\)/)
  assert.match(puristSource, /event\.button === 1/)
  assert.match(puristSource, /workspaceTabs\.map[\s\S]*?<button[\s\S]*?title="New tab"[\s\S]*?<\/div>\s*<\/div>/)
})

test('Topbar Island is collapsed by default and expands only for browser activity', () => {
  assert.match(puristSource, /const \[expanded, setExpanded\] = useState\(false\)/)
  assert.match(puristSource, /data-testid="purist-topbar-island"/)
  assert.match(puristSource, /data-state=\{expanded \? 'expanded' : 'collapsed'\}/)
  assert.match(puristSource, /className="topbar-island-compact/)
  assert.match(puristSource, /activeTab\?\.status === 'loading'/)
  assert.match(puristSource, /window\.addEventListener\('vast-focus-address', revealForAddress\)/)
  assert.match(puristSource, /document\.addEventListener\('pointerdown', collapseFromPage, true\)/)
  assert.match(puristSource, /event\.key !== 'Escape'/)
  assert.match(addressSource, /onFocusChange\?: \(focused: boolean\) => void/)
  assert.match(puristSource, /const ISLAND_COLLAPSE_DELAY = 850/)
  assert.match(puristSource, /vast-purist-page-scroll/)
})

test('Purist reveals browser-owned safe space only after an explicit overscroll beyond the page top', () => {
  assert.match(guestPreloadSource, /sendToHost\('vast:scroll-boundary', atTop\)/)
  assert.match(guestPreloadSource, /topOverscrollDistance >= 18/)
  assert.match(guestPreloadSource, /sendToHost\('vast:purist-top-overscroll', 'show'\)/)
  assert.match(guestPreloadSource, /sendToHost\('vast:purist-top-overscroll', 'hide'\)/)
  assert.match(browserRuntimeSource, /message\.channel === 'vast:scroll-boundary'/)
  assert.match(browserRuntimeSource, /message\.channel === 'vast:purist-top-overscroll'/)
  assert.match(browserRuntimeSource, /className={`browser-webview-frame \$\{puristSafeSpace && puristSafeSpaceVisible/)
  assert.doesNotMatch(browserRuntimeSource, /puristSafeSpace && atScrollTop/)
  assert.match(appSource, /puristChromeVisible=\{showPuristChrome\}/)
  assert.match(stylesSource, /data-purist-island='collapsed'[\s\S]*?grid-template-rows:\s*50px/)
  assert.match(stylesSource, /data-purist-island='expanded'[\s\S]*?grid-template-rows:\s*150px/)
  assert.match(stylesSource, /\.purist-scroll-safe-space\s*{[^}]*background:\s*#000;/s)
})

test('Purist inactive, interactive, and active tab surfaces are deliberately distinct', () => {
  assert.match(stylesSource, /\.purist-tab-surface\s*{[^}]*background:\s*transparent;[^}]*opacity:\s*0\.78;/s)
  assert.match(stylesSource, /\.purist-tab:hover \.purist-tab-surface,[\s\S]*?\.purist-tab:focus-within \.purist-tab-surface\s*{/)
  assert.match(stylesSource, /\.purist-tab\.is-active \.purist-tab-surface\s*{[^}]*background:/s)
  assert.match(stylesSource, /\.purist-tab\.is-pinned\s*{[^}]*width:\s*34px;/s)
  assert.match(stylesSource, /\.purist-tab-viewport::\-webkit-scrollbar\s*{[^}]*display:\s*none;/s)
})

test('Purist chrome stays rounded, restrained, responsive, and transparency-safe', () => {
  assert.match(stylesSource, /\.layout-purist \.purist-chrome\s*{[^}]*position:\s*absolute;[^}]*pointer-events:\s*none;/s)
  assert.match(stylesSource, /\.purist-chrome-surface\s*{[^}]*backdrop-filter:/s)
  assert.match(stylesSource, /\.topbar-island\.is-collapsed\s*{[^}]*width:\s*min\(320px,[^}]*max-height:\s*40px;[^}]*border-radius:\s*999px;/s)
  assert.match(stylesSource, /\.topbar-island\.is-expanded \.topbar-island-expanded\s*{[^}]*opacity:\s*1;/s)
  assert.match(stylesSource, /\.address-bar-purist\s*{[^}]*grid-template-columns:/s)
  assert.match(stylesSource, /\.vast-top-address-purist\s*{[^}]*border-radius:\s*999px !important;/s)
  assert.match(stylesSource, /@media \(max-width: 680px\)[\s\S]*?\.address-bar-purist/)
  assert.match(stylesSource, /@media \(prefers-reduced-transparency: reduce\)[\s\S]*?\.purist-chrome-surface/)
  assert.match(horizontalSource, /variant === 'purist' && orderedItems\.length === 0/)
  assert.doesNotMatch(puristSource, />\s*(Purist|Safari|Minimal|Premium)\s*</i)
})

test('Purist embeds Vast-owned window controls in the expanded island', () => {
  assert.match(puristSource, /<PuristTabStrip \/>\s*<WindowControls \/>/)
  assert.match(windowControlsSource, /vast-window-control is-close/)
  assert.match(windowControlsSource, /window\.vast\.app\.window\.toggleMaximize\(\)/)
  assert.match(windowControlsSource, /window\.vast\.app\.window\.minimize\(\)/)
  assert.match(windowControlsSource, /window\.vast\.app\.window\.close\(\)/)
})

test('Purist disappears from Layout choices while Experimental features is disabled', () => {
  assert.match(settingsSource, /\.\.\.\(settings\.advanced\.experimentalFeatures[\s\S]*?\? \[\{ value: 'purist' as const, label: 'Purist' \}\][\s\S]*?: \[\]\)/)
  assert.doesNotMatch(settingsSource, /description: 'Requires Experimental features'/)
})
