import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import test from 'node:test'

const source = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/shared/types.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const registrySource = readFileSync(new URL('../../src/main/windows/WindowRegistry.ts', import.meta.url), 'utf8')
const motionSource = readFileSync(new URL('../../src/renderer/lib/tab-motion.ts', import.meta.url), 'utf8')

test('horizontal titlebar leaves blank tab-strip space draggable', () => {
  const titlebarLine = source.split('\n').find((line) => line.includes('horizontal-titlebar-row')) ?? ''
  assert.equal(titlebarLine.includes('no-drag'), false)
  assert.match(source, /horizontal-tab-strip[^"]*drag/)
})

test('workspace popover uses a clear product heading without technical helper copy', () => {
  assert.match(source, /<h2 className="text-2xl font-semibold leading-tight tracking-tight text-white" data-testid="workspace-popover-heading">Workspaces<\/h2>/)
  assert.doesNotMatch(source, /Isolated workspaces use a temporary Chromium session/)
  assert.doesNotMatch(source, />Workspaces<\/div>/)
})

test('dragging a tab out requests a detached Vast window', () => {
  assert.match(source, /onDragEnd=\{\(event\) => onTabDragEnd\(event, tab\)\}/)
  assert.match(source, /window\.vast\.browser\.detachTab\(payload\)/)
  assert.match(preloadSource, /vast:browser:detach-tab/)
  assert.match(preloadSource, /vast:browser:sync-detached-tab/)
  assert.match(typesSource, /detachTab: \(tab: DetachedTabPayload\)/)
  assert.match(typesSource, /syncDetachedTab: \(tab: DetachedTabPayload\)/)
  assert.match(ipcSource, /vast:browser:detach-tab/)
  assert.match(ipcSource, /vast:browser:sync-detached-tab/)
  assert.match(windowSource, /detachedTab/)
  assert.match(appSource, /buildDetachedTabData/)
  assert.match(appSource, /syncDetachedFinalTab/)
  assert.match(source, /sourceTabId: tab\.id/)
  assert.match(source, /sourceWorkspaceId: tab\.workspaceId/)
})

test('a detached tab can be dropped back into the main Vast window under the cursor', () => {
  assert.match(source, /window\.vast\.browser\.reattachDetachedTab\(payload\)/)
  assert.match(preloadSource, /vast:browser:reattach-detached-tab/)
  assert.match(typesSource, /reattachDetachedTab: \(tab: DetachedTabPayload\)/)
  assert.match(typesSource, /onDetachedTabReattach/)
  assert.match(ipcSource, /reattachTargetAt\(screen\.getCursorScreenPoint\(\), sourceWindow\)/)
  assert.match(ipcSource, /targetWindow\.webContents\.send\('vast:browser:reattach-detached-tab'/)
  assert.match(registrySource, /if \(pointIsInsideSource\) return undefined/)
  assert.match(registrySource, /this\.kindOf\(window\) !== 'detached'/)
  assert.match(appSource, /onDetachedTabReattach/)
})

test('tab insertion and reordering use quick FLIP motion with reduced-motion support', () => {
  assert.match(source, /useTabMotion\(tab\.id\)/)
  assert.match(motionSource, /stableLayoutBox/)
  assert.match(motionSource, /visualBeforeRetarget/)
  assert.match(motionSource, /activeMotion\?\.cancel\(\)/)
  assert.match(motionSource, /duration: 160/)
  assert.match(motionSource, /prefers-reduced-motion: reduce/)
})
