import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const stageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const tabOpenSource = readFileSync(new URL('../../src/renderer/lib/browser-tab-open.ts', import.meta.url), 'utf8')

test('temporary sessions do not force ad blocking when the ad blocker is disabled', () => {
  assert.match(sessionsSource, /const adBlocking = settings\.privacy\.adBlockerEnabled/)
  assert.doesNotMatch(sessionsSource, /const adBlocking = isTemporarySession \|\| settings\.privacy\.adBlockerEnabled/)
})

test('renderer has no duplicate legacy new-window routing path', () => {
  assert.doesNotMatch(stageSource, /addEventListener\(['"]new-window['"]/)
  assert.doesNotMatch(stageSource, /routeWebviewWindowOpen/)
})

test('typed main-process tab requests preserve source tab ownership and activation', () => {
  assert.match(appSource, /onOpenTabRequest/)
  assert.match(tabOpenSource, /getTabIdForWebContents\(request\.sourceWebContentsId\)/)
  assert.match(tabOpenSource, /workspaceId: sourceTab\?\.workspaceId/)
  assert.match(tabOpenSource, /groupId: sourceTab\?\.groupId/)
  assert.match(tabOpenSource, /activate: request\.activate/)
})

test('main process dispatches tab-disposition routes into Vast tabs', () => {
  assert.match(sessionsSource, /if \(route === 'vast-tab' && isSafeWebUrl\(url\)\)/)
  assert.match(sessionsSource, /dispatchBrowserTabOpenRequest\(contents,/)
  assert.match(sessionsSource, /sourceWebContentsId: isWebviewGuest \? contents\.id : undefined/)
  assert.match(sessionsSource, /activate: disposition !== 'background-tab'/)
  assert.match(sessionsSource, /return \{ action: 'deny' \}/)
})
