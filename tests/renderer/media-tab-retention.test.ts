import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const retentionSource = readFileSync(new URL('../../src/renderer/components/browser/TabRetentionController.ts', import.meta.url), 'utf8')
const browserRuntimeSource = `${browserStageSource}\n${webviewSurfaceSource}\n${retentionSource}`
const tabStoreSource = readFileSync(new URL('../../src/renderer/store/browser-store.ts', import.meta.url), 'utf8')

test('automatic tab hibernation keeps actively playing media tabs mounted', () => {
  assert.match(browserRuntimeSource, /mediaActiveTabIds/)
  assert.match(browserRuntimeSource, /media-started-playing/)
  assert.match(browserRuntimeSource, /media-paused/)
  assert.match(browserRuntimeSource, /isCurrentlyAudible/)
  assert.match(browserRuntimeSource, /const retained = new Set<ID>\(\[\.\.\.visibleIds, \.\.\.callRetainedIds, \.\.\.pinnedRetainedIds\]\)/)
  assert.match(browserRuntimeSource, /visibleIdSet\.has\(tab\.id\) \|\| callProtectedTabIds\.has\(tab\.id\)[\s\S]*\? 'active'/)
  assert.match(browserRuntimeSource, /setBackgroundThrottling|setKeepAwake/)
})

test('manual inactive-tab unload uses the shared protected-tab decision', () => {
  assert.match(tabStoreSource, /const active = activeTabInWorkspace\(state, state\.activeWorkspaceId\)/)
  assert.match(tabStoreSource, /isInactiveTabUnloadCandidate/)
  assert.match(tabStoreSource, /keepAwakeTabIds: state\.keepAwakeTabIds/)
})
