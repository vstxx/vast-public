import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const storeSource = readFileSync(new URL('../../src/renderer/store/browser-store.ts', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const splitSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/SplitViewSurface.tsx', import.meta.url), 'utf8')
const stageSource = `${browserStageSource}\n${webviewSurfaceSource}\n${splitSurfaceSource}`
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../../src/renderer/components/tabs/Sidebar.tsx', import.meta.url), 'utf8')
const brandSource = readFileSync(new URL('../../src/renderer/components/ui/BrandMark.tsx', import.meta.url), 'utf8')
const horizontalChromeSource = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8')
const puristChromeSource = readFileSync(new URL('../../src/renderer/components/purist/PuristChrome.tsx', import.meta.url), 'utf8')
const tabRowSource = readFileSync(new URL('../../src/renderer/components/tabs/TabRow.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const storageSource = readFileSync(new URL('../../src/main/storage.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/shared/types.ts', import.meta.url), 'utf8')

test('layout mode supports the vertical, horizontal, and purist variants', () => {
  assert.match(typesSource, /LayoutMode = 'vertical' \| 'horizontal' \| 'purist'/)
  assert.match(storageSource, /\['layoutMode', new Set\(\['vertical', 'horizontal', 'purist'\]\)\]/)
  assert.match(settingsSource, /\{ value: 'vertical', label: 'Vertical' \}[\s\S]*\{ value: 'horizontal', label: 'Horizontal' \}[\s\S]*\.\.\.\(settings\.advanced\.experimentalFeatures[\s\S]*?value: 'purist' as const[\s\S]*?: \[\]\)/)
  assert.match(storeSource, /resolveLayoutMode\(requestedLayoutMode, advanced\.experimentalFeatures\)/)
  assert.match(appSource, /resolveLayoutMode\(requestedLayoutMode, experimentalFeatures\)/)
  assert.match(storageSource, /next\.layoutMode = resolveLayoutMode\(next\.layoutMode, next\.advanced\.experimentalFeatures\)/)
  assert.match(appSource, /showSidebar = [^\n]*layoutMode === 'vertical'/)
  assert.match(appSource, /showHorizontalChrome = [^\n]*layoutMode === 'horizontal'/)
  assert.match(appSource, /showPuristChrome = [^\n]*layoutMode === 'purist'/)
  assert.match(appSource, /showPuristChrome && <Suspense fallback=\{null\}><PuristChrome \/><\/Suspense>/)
  assert.match(puristChromeSource, /<AddressBar compact variant="purist"/)
})

test('Developer settings stay behind the Developer Mode notification', () => {
  const developerStart = settingsSource.indexOf('<section id="Developer"')
  const developerEnd = settingsSource.indexOf('<section id="Privacy"', developerStart)

  assert.ok(developerStart >= 0)
  assert.ok(developerEnd > developerStart)
  const developerSource = settingsSource.slice(developerStart, developerEnd)
  assert.match(developerSource, /!settings\.advanced\.developerMode \? \(/)
  assert.match(developerSource, /<NotificationCard role="status" className="settings-developer-notification/)
  assert.match(developerSource, /Developer Mode required/)
  assert.match(developerSource, /updateSettings\(\{ advanced: \{ developerMode: true \} \}\)/)
  assert.match(developerSource, /\) : <>[\s\S]*Open tab DevTools/)
})

test('split view owns a stable two-tab pair instead of deriving the left pane from focus', () => {
  assert.match(storeSource, /primaryTabId/)
  assert.match(storeSource, /splitViewAfterTabActivation/)
  assert.match(stageSource, /return \[primaryTab\.id, secondaryTab\.id\]/)
  assert.match(appSource, /setSplitView\(true, secondary\.id, active\.id\)/)
})

test('split view exposes focused pane chrome, swapping, resizing, and a clean exit', () => {
  assert.match(stageSource, /data-testid="split-pane-header"/)
  assert.match(stageSource, /data-testid="split-resizer"/)
  assert.match(stageSource, /Swap split panes/)
  assert.match(stageSource, /Exit split view/)
  assert.match(stageSource, /onFocused=\{focusPane\}/)
  assert.match(stageSource, /aria-valuemin=\{28\}/)
  assert.match(stageSource, /aria-valuemax=\{72\}/)
})

test('split panes are locked to one grid row and cannot auto-flow into four quadrants', () => {
  assert.match(stylesSource, /\.browser-stage-pane\s*{[^}]*grid-row:\s*1;/s)
  assert.match(stageSource, /gridTemplateRows: 'minmax\(0,1fr\)'/)
  assert.match(stageSource, /className={`browser-stage-pane relative flex/)
  assert.match(stageSource, /className={`browser-stage-pane relative min-h-0 overflow-hidden/)
  assert.doesNotMatch(stageSource, /gridColumn: visible \? splitIndex \+ 1/)
})

test('split interactions focus only their owning pane and commit resize safely', () => {
  const mouseNavigationStart = stageSource.indexOf('const onMouseNavigation =')
  const mouseNavigationEnd = stageSource.indexOf('const onFocusedSurface =', mouseNavigationStart)
  const mouseNavigationSource = stageSource.slice(mouseNavigationStart, mouseNavigationEnd)

  assert.match(mouseNavigationSource, /if \(!visibleRef\.current\) return/)
  assert.match(mouseNavigationSource, /onFocused\(tab\.id\)/)
  assert.match(mouseNavigationSource, /runtime\.goBack\(\)/)
  assert.match(stageSource, /const onFocusedSurface = \(\): void => \{[\s\S]{0,80}visibleRef\.current/)
  assert.match(stageSource, /const onContextMenu = \(event: Event\): void => \{[\s\S]{0,100}onFocused\(tab\.id\)/)
  assert.match(stageSource, /onPointerCancel=[\s\S]{0,240}commitSplitRatio\(\)/)
  assert.match(stageSource, /splitRatioRef\.current/)
  assert.doesNotMatch(stageSource, /<section[\s\S]{0,420}onPointerDown=\{\(\) => focusPane\(tab\.id\)\}[\s\S]{0,80}<SplitPaneHeader/)
})

test('swapping rejects stale or cross-workspace split pairs', () => {
  const swapStart = storeSource.indexOf('swapSplitPanes: () => set')
  const swapEnd = storeSource.indexOf('setActiveWorkspace:', swapStart)
  const swapSource = storeSource.slice(swapStart, swapEnd)

  assert.match(swapSource, /primary\.workspaceId !== state\.activeWorkspaceId/)
  assert.match(swapSource, /secondary\.workspaceId !== state\.activeWorkspaceId/)
  assert.match(swapSource, /disabledSplitView\(state\.splitView\.ratio\)/)
})

test('closing, switching workspaces, and manual unloading cannot leave an invalid split pair', () => {
  assert.match(storeSource, /closingSplitPane/)
  assert.match(storeSource, /splitView: closingSplitPane \? disabledSplitView/)
  assert.match(storeSource, /setActiveWorkspace:[\s\S]*splitView: disabledSplitView/)
  assert.match(storeSource, /splitView: disabledSplitView\(current\.splitView\.ratio\),[\s\S]*sessionSnapshots: appendSessionSnapshot/)
  assert.match(storeSource, /splitTabIds: state\.splitView\.enabled/)
  assert.match(storeSource, /state\.splitView\.primaryTabId, state\.splitView\.secondaryTabId/)
})

test('workspace lifecycle and hydration preserve the split active-pane invariant', () => {
  assert.match(storeSource, /const restoredWorkspaces = restoredSplitView\.enabled/)
  assert.match(storeSource, /workspace\.activeTabId !== restoredSplitView\.primaryTabId/)
  assert.match(storeSource, /workspaces: restoredWorkspaces/)
  assert.match(storeSource, /activeWorkspaceId: workspace\.id,[\s\S]{0,100}splitView: disabledSplitView\(state\.splitView\.ratio\)/)
  assert.match(storeSource, /current\.activeWorkspaceId === workspaceId \|\| \([\s\S]{0,260}disabledSplitView\(current\.splitView\.ratio\)/)
  assert.match(storeSource, /active\.id !== primary\.id && active\.id !== secondary\.id/)
})

test('vertical sidebar is a flat tab list with one clean bottom New tab action', () => {
  assert.doesNotMatch(sidebarSource, /TabGroupSection|New tab group|Search or enter address/)
  assert.doesNotMatch(brandSource, /local by default/i)
  assert.match(sidebarSource, /data-testid="vertical-tabs-list"/)
  assert.match(sidebarSource, /data-testid="vertical-new-tab"/)
})

test('vertical layout uses the compact omnibox and every new tab is appended to the strip', () => {
  assert.match(appSource, /layoutMode === 'vertical' && <AddressBar compact \/>/)
  assert.match(storeSource, /tabs:\s*\[\.\.\.current\.tabs, tab\]/)
  assert.doesNotMatch(storeSource, /nextTabs\.splice\(activeIndex \+ 1/)
})

test('active tab outline is subtle and always follows the secondary accent', () => {
  assert.match(horizontalChromeSource, /active \? 'vast-tab-active' : ''/)
  assert.match(tabRowSource, /active \? 'vast-tab-active' : ''/)
  assert.match(stylesSource, /\.vast-tab-active\s*\{[^}]*var\(--vast-accent-secondary\) 28%/s)
  assert.doesNotMatch(horizontalChromeSource, /active[\s\S]{0,120}border-vast-cyan/)
})
