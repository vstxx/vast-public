import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const splashSource = readFileSync(new URL('../../src/main/opening-splash.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const sequenceSource = readFileSync(new URL('../../src/shared/opening-sequence.ts', import.meta.url), 'utf8')

test('splash and the primary browser window are separate, and the splash hosts no browser app', () => {
  assert.match(mainSource, /import \{ createOpeningSplashWindow, type OpeningSplashController \} from '\.\/opening-splash'/)
  assert.match(mainSource, /let openingSplash: OpeningSplashController \| undefined/)
  assert.match(mainSource, /if \(openingEnabled\) \{\s*openingSplash = createOpeningSplashWindow\(/)
  assert.match(mainSource, /createMainWindow\(onDataSaved, \(\) => currentSettings, \{\s*kind: 'primary'/)
  assert.equal((windowSource.match(/new BrowserWindow\(/g) ?? []).length, 1)
  assert.doesNotMatch(splashSource, /webviewTag|preload:|index\.html/)
  assert.match(splashSource, /loadURL\(splashDocument\(/)
})

test('the primary browser window is created immediately, hidden, at its final bounds', () => {
  assert.match(mainSource, /showInitially: !openingEnabled/)
  assert.doesNotMatch(mainSource, /showWhenReady: openingEnabled/)
  assert.match(windowSource, /show: options\?\.showInitially \?\? true/)
  assert.match(windowSource, /\.\.\.targetBounds/)
  assert.match(windowSource, /persistWindowState\(mainWindow, windowKind\)/)
  assert.match(windowSource, /if \(savedWindowState\?\.maximized\) mainWindow\.once\('ready-to-show', \(\) => mainWindow\.maximize\(\)\)/)
  assert.doesNotMatch(windowSource, /openingPresentation|revealBrowserWindow|setShape|OPENING_PRESENTATION|OPENING_COMPLETE_IPC_CHANNEL/)
})

test('real startup work continues while the splash is active', () => {
  const splashIndex = mainSource.indexOf('createOpeningSplashWindow(')
  const primaryIndex = mainSource.indexOf("kind: 'primary'")
  assert.ok(splashIndex > -1 && primaryIndex > splashIndex, 'expected splash creation immediately before primary window creation')
  assert.match(mainSource, /markPerformance\('primary-window-created'\)/)
  assert.match(mainSource, /externalNavigationRouter\.acceptArguments\(process\.argv\)/)
  assert.match(mainSource, /mainWindow\.webContents\.once\('did-finish-load'/)
})

test('browser reveal requires animationComplete AND browserReady', () => {
  assert.match(mainSource, /let openingAnimationComplete = !openingEnabled/)
  assert.match(mainSource, /let primaryBrowserReady = !openingEnabled/)
  assert.match(mainSource, /let primaryRevealed = !openingEnabled/)
  const reveal = mainSource.match(/const revealPrimaryBrowser = \(\): void => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.match(reveal, /if \(primaryRevealed \|\| mainWindow\.isDestroyed\(\)\) return/)
  assert.match(reveal, /if \(!openingAnimationComplete \|\| !primaryBrowserReady\) return/)
  assert.match(reveal, /mainWindow\.show\(\)/)
  assert.match(reveal, /mainWindow\.focus\(\)/)
  assert.match(reveal, /openingSplash\?\.beginExit\(/)
  assert.match(mainSource, /markPerformance\('primary-browser-revealed'/)
  assert.match(mainSource, /markPerformance\('opening-splash-destroyed'/)
})

test('browser-ready-first and animation-complete-first paths both converge on the reveal', () => {
  assert.match(mainSource, /const markPrimaryBrowserReady = \(\): void => \{[\s\S]*?revealPrimaryBrowser\(\)/)
  assert.match(mainSource, /const markOpeningAnimationComplete = \(\): void => \{[\s\S]*?revealPrimaryBrowser\(\)/)
  assert.match(mainSource, /ipcMain\.on\('vast:renderer-ui-ready', \(event\) => \{\s*if \(mainWindow\.isDestroyed\(\) \|\| event\.sender !== mainWindow\.webContents\) return\s*markPrimaryBrowserReady\(\)/)
})

test('the animation clock lives in the main process and never restarts', () => {
  assert.match(splashSource, /animationTimer = setTimeout\(finishAnimation, OPENING_SEQUENCE\.totalMs\)/)
  assert.match(splashSource, /let animationFinished = false/)
  assert.match(splashSource, /const finishAnimation = \(\): void => \{\s*if \(animationFinished\) return/)
  assert.match(splashSource, /splash\.webContents\.on\('render-process-gone', finishAnimation\)/)
  assert.doesNotMatch(splashSource, /setInterval\(/)
})

test('disabling the opening animation creates no splash and preserves direct startup', () => {
  assert.match(mainSource, /if \(openingEnabled\) \{\s*openingSplash = createOpeningSplashWindow\(/)
  assert.match(mainSource, /let openingAnimationComplete = !openingEnabled/)
  assert.match(mainSource, /let primaryBrowserReady = !openingEnabled/)
  assert.match(mainSource, /showInitially: !openingEnabled/)
})

test('an emergency timeout exists but readiness signals are the normal path', () => {
  assert.match(mainSource, /openingEmergencyTimer = setTimeout\(/)
  assert.match(mainSource, /OPENING_PRESENTATION\.fallbackTimeoutMs/)
  assert.match(mainSource, /opening-splash-emergency-reveal/)
  assert.doesNotMatch(splashSource, /OPENING_PRESENTATION\.fallbackTimeoutMs/)
})

test('the splash is compact, frameless, taskbar-free and centered', () => {
  assert.match(splashSource, /const display = screen\.getPrimaryDisplay\(\)/)
  assert.match(splashSource, /Math\.round\(workArea\.x \+ \(workArea\.width - width\) \/ 2\)/)
  assert.match(splashSource, /skipTaskbar: true/)
  assert.match(splashSource, /frame: false/)
  assert.match(splashSource, /thickFrame: false/)
  assert.match(splashSource, /resizable: false/)
  assert.match(splashSource, /hasShadow: false/)
  assert.match(splashSource, /splash\.setAlwaysOnTop\(true, 'floating'\)/)
  assert.match(splashSource, /splash\.setShape\(roundedWindowShape\(width, height, options\.cornerRadius\)\)/)
  assert.match(splashSource, /splash\.destroy\(\)/)
})

test('the main renderer no longer hosts the opening animation and reports UI readiness instead', () => {
  assert.doesNotMatch(appSource, /VastOpeningAnimation|vast-opening-overlay|OPENING_COMPLETE_MESSAGE|playOpeningSerenitySound/)
  assert.doesNotMatch(preloadSource, /OPENING_COMPLETE_IPC_CHANNEL|OPENING_COMPLETE_MESSAGE/)
  assert.match(preloadSource, /uiReady: \(\) => ipcRenderer\.send\('vast:renderer-ui-ready'\)/)
  assert.match(appSource, /window\.vast\.app\.uiReady\(\)/)
  assert.match(appSource, /if \(!hydrated && !loadError\) return/)
  assert.match(appSource, /window\.requestAnimationFrame\(\(\) => window\.vast\.app\.uiReady\(\)\)/)
})

test('the standalone splash document keeps the measured visual system and audio timeline', () => {
  assert.match(splashSource, /vast-opening-backdrop/)
  assert.match(splashSource, /vast-opening-logo-halo/)
  assert.match(splashSource, /vast-opening-logo-frame/)
  assert.match(splashSource, /vast-opening-logo/)
  assert.match(splashSource, /brightness\(0\) invert\(1\)/)
  assert.match(splashSource, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(splashSource, /openingAudioScriptSource\(\)/)
  assert.match(splashSource, /AUDIO\.durationMs \+ AUDIO\.closeBufferMs/)
  assert.match(sequenceSource, /exitFadeMs: 180/)
  assert.match(sequenceSource, /fallbackTimeoutMs: 15_000/)
})
