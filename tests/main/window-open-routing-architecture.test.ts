import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')

test('setWindowOpenHandler is the authoritative web-content routing boundary', () => {
  assert.match(sessionsSource, /setWindowOpenHandler/)
  assert.match(sessionsSource, /routeWebviewWindowOpen/)
  assert.doesNotMatch(sessionsSource, /\.on\(['"]new-window['"]/)
  assert.doesNotMatch(preloadSource, /vast:new-window-url/)
  assert.ok(webviewSurfaceSource.indexOf("setAttribute('allowpopups', '')") < webviewSurfaceSource.indexOf("setAttribute('src', initialUrlRef.current)"))
})

test('real popup windows retain opener session without receiving a preload', () => {
  assert.match(sessionsSource, /webPreferences\.session = openerSession/)
  assert.match(sessionsSource, /delete webPreferences\.preload/)
  assert.match(sessionsSource, /nodeIntegration: false/)
  assert.match(sessionsSource, /contextIsolation: true/)
  assert.match(sessionsSource, /sandbox: true/)
  assert.match(sessionsSource, /webSecurity: true/)
  assert.match(sessionsSource, /allowRunningInsecureContent: false/)
  assert.match(sessionsSource, /shouldLoadPopupInitialUrl/)
  assert.match(sessionsSource, /popup\.loadURL\(initialUrl\)/)
})

test('popup close removes every tracked reference', () => {
  assert.match(sessionsSource, /popup\.on\('closed',[\s\S]*adBlockGuardedPopupWebContents\.delete\(popupContentsId\)/)
  assert.match(sessionsSource, /popup\.on\('closed',[\s\S]*trustedOAuthPopupWebContents\.delete\(popupContentsId\)/)
})

test('IPC registration is one-shot and never removes global handlers per window', () => {
  assert.match(ipcSource, /if \(ipcRegistered\) throw new Error/)
  assert.doesNotMatch(ipcSource, /ipcMain\.removeHandler/)
  assert.match(ipcSource, /windowRegistry\.vastWindowForWebContents\(event\.sender\)/)
})
