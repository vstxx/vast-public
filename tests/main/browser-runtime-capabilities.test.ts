import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const externalProtocolSource = readFileSync(new URL('../../src/main/external-protocol.ts', import.meta.url), 'utf8')
const guestRuntimeSource = readFileSync(new URL('../../src/main/guest-runtime-events.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const retentionSource = readFileSync(new URL('../../src/renderer/components/browser/TabRetentionController.ts', import.meta.url), 'utf8')
const browserRuntimeSource = `${browserStageSource}\n${webviewSurfaceSource}\n${retentionSource}`
const storeSource = readFileSync(new URL('../../src/renderer/store/browser-store.ts', import.meta.url), 'utf8')
const lifecycleSource = readFileSync(new URL('../../src/renderer/store/tab-lifecycle.ts', import.meta.url), 'utf8')

test('HTML video fullscreen owns the Vast window and renderer stage until the guest exits', () => {
  assert.match(guestRuntimeSource, /enter-html-full-screen/)
  assert.match(guestRuntimeSource, /leave-html-full-screen/)
  assert.match(guestRuntimeSource, /owner\.setFullScreen\(true\)/)
  assert.match(guestRuntimeSource, /sessionWindow\.setFullScreen\(false\)/)
  assert.match(guestRuntimeSource, /guestWebContentsId === contents\.id/)
  assert.match(preloadSource, /onHtmlFullscreenState/)
  assert.match(appSource, /htmlFullscreenSession/)
  assert.match(browserStageSource, /data-html-fullscreen/)
})

test('external app links require a one-time renderer notification approval', () => {
  assert.match(sessionsSource, /requestExternalProtocolOpen\(contents, url\)/)
  assert.match(externalProtocolSource, /pending\.ownerWebContentsId !== sender\.id/)
  assert.match(externalProtocolSource, /sourceOrigin\(source\) !== pending\.sourceOrigin/)
  assert.match(externalProtocolSource, /await shell\.openExternal\(pending\.url\)/)
  assert.match(ipcSource, /vast:browser:resolve-external-protocol/)
  assert.match(preloadSource, /vast:browser:external-protocol-request/)
  assert.match(appSource, /title: `Open \$\{request\.scheme\} app\?`/)
  assert.match(appSource, /label: 'Open app'/)
  assert.match(appSource, /durationMs: 0/)
})

test('application CSP is never injected into ordinary loopback websites', () => {
  assert.match(sessionsSource, /const isInternalResponse = isTrustedRendererUrl\(details\.url,/)
  assert.doesNotMatch(sessionsSource, /details\.url\.startsWith\('http:\/\/localhost:'\)/)
  assert.doesNotMatch(sessionsSource, /details\.url\.startsWith\('http:\/\/127\.0\.0\.1:'\)/)
})

test('camera, microphone, screen share, media playback and call pages protect tabs from every unload path', () => {
  assert.match(sessionsSource, /protectGuestMediaCapture\(webContents\)/)
  assert.match(sessionsSource, /protectGuestMediaCapture\(requestingContents\)/)
  assert.match(browserRuntimeSource, /media-started-playing/)
  assert.match(browserRuntimeSource, /captureActiveWebContentsIds/)
  assert.match(browserRuntimeSource, /isLikelyCallUrl\(tab\.url\)/)
  assert.match(browserRuntimeSource, /setKeepAwakeTabIds/)
  assert.match(browserRuntimeSource, /window\.vast\.browser\.setKeepAwake/)
  assert.match(browserRuntimeSource, /register\(tab\.id, webview\)/)
  assert.match(browserRuntimeSource, /callProtectedTabIdsRef\.current\.has\(tabId\)/)
  assert.match(ipcSource, /target\.setBackgroundThrottling\(!keepAwake\)/)
  assert.match(storeSource, /isInactiveTabUnloadCandidate/)
  assert.match(appSource, /isInactiveTabUnloadCandidate/)
  assert.match(lifecycleSource, /context\.keepAwakeTabIds\.includes\(tab\.id\)/)
})
