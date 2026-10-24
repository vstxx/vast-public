import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const surface = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../../src/main/guest-runtime-events.ts', import.meta.url), 'utf8')
const handler = (name: string, next: string): string => surface.slice(surface.indexOf(`const ${name} = `), surface.indexOf(`const ${next} = `))

// getURL, getTitle, canGoBack/canGoForward and setAudioMuted on a <webview> are
// synchronous IPC to the main process; page events must not call them.
const SYNC = /webview\.(getURL|getTitle|canGoBack|canGoForward)\(/

test('page event handlers make no synchronous webview calls', () => {
  for (const [name, next] of [['rememberCurrentSite', 'onDomReady'], ['onDomReady', 'onStart'], ['onStop', 'onNavigate'], ['onNavigate', 'onNavigationState'], ['onNavigationState', 'onTitle'], ['onTitle', 'onFavicon'], ['onFavicon', 'onFail']]) {
    assert.doesNotMatch(handler(name, next), SYNC, name)
  }
  assert.doesNotMatch(handler('onDomReady', 'onStart'), /setAudioMuted\?\.\(Boolean\(/, 'unmuted guests need no mute call')
})

test('back/forward, history and site memory come from main-process navigation state', () => {
  assert.match(runtime, /canGoBack: contents\.navigationHistory\.canGoBack\(\)/)
  assert.match(runtime, /contents\.on\('did-navigate-in-page', \(_event, _url, isMainFrame\) => \{[\s\S]*?if \(isMainFrame\) setImmediate\(\(\) => sendNavigationState\(contents, 'navigate'\)\)/)
  assert.match(runtime, /contents\.on\('did-stop-loading', \(\) => sendNavigationState\(contents, 'stop'\)\)/)
  const onState = handler('onNavigationState', 'onTitle')
  assert.match(onState, /if \(state\.webContentsId !== webContentsIdRef\.current\) return/)
  assert.match(onState, /updateTab\(tab\.id, \{ canGoBack: state\.canGoBack, canGoForward: state\.canGoForward \}\)/)
  assert.match(onState, /addHistoryEntry\(\{\s+title: state\.title \|\| latestTab\.title,\s+url: state\.url/)
  assert.match(surface, /for \(const state of unmatchedNavigationStates\.splice\(0\)\) onNavigationState\(state\)/, 'a first navigation reported before the id is known is replayed')
})
