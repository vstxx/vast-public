import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import test from 'node:test'

const source = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const typesSource = readFileSync(new URL('../../src/shared/types.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const registrySource = readFileSync(new URL('../../src/main/windows/WindowRegistry.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const motionSource = readFileSync(new URL('../../src/renderer/lib/tab-motion.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('horizontal titlebar leaves blank tab-strip space draggable', () => {
  const titlebarLine = source.split('\n').find((line) => line.includes('horizontal-titlebar-row')) ?? ''
  assert.equal(titlebarLine.includes('no-drag'), false)
  // Blank space after the tabs belongs to the draggable bar; the scrolling
  // strip itself is no-drag so wheel and clicks reach it.
  assert.match(source, /<div ref=\{barRef\} className="drag flex min-w-0 flex-1 items-center gap-1"[^>]*>/)
  assert.match(source, /className="horizontal-tab-strip no-drag relative flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden py-1"/)
})

test('tab overflow is aligned and exposes lifecycle plus direct close controls', () => {
  assert.match(source, /overflowRef[^\n]*translate-y-1 self-center/)
  assert.match(source, /function overflowTabState\(tab: Tab, active: boolean\)/)
  for (const state of ['Crashed', 'Load failed', 'Active', 'Sleeping', 'Unloaded', 'Ready']) {
    assert.match(source, new RegExp(`label: '${state}`))
  }
  assert.match(source, /label: `Loading \$\{/)
  assert.match(source, /aria-label=\{`Close \$\{tab\.title\}`\}/)
  assert.match(source, /closeTab\(tab\.id\)/)
  assert.match(source, /document\.addEventListener\('pointerdown', onPointerDown, true\)/)
  assert.match(source, /event\.key === 'Escape'/)
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
  assert.match(source, /useTabMotion\(tab\.id, layoutKey\)/)
  // First positions are read inside the store update, before React renders.
  assert.match(motionSource, /useBrowserStore\.subscribe\(\(state, previous\) => \{/)
  assert.match(motionSource, /stripSignature\(state\) !== stripSignature\(previous\)\) capture\(\)/)
  assert.match(motionSource, /runningMotion\(element\)\?\.cancel\(\)/)
  assert.match(motionSource, /duration: 170/)
  assert.match(motionSource, /prefers-reduced-motion: reduce/)
  assert.match(motionSource, /element\.closest\('\.no-motion'\)/)
})

test('closing a tab slides the others without stretching them', () => {
  // Translate only: a width change never becomes a scale, so text never squishes.
  assert.doesNotMatch(motionSource, /scale[XY]?\(\$\{/)
  assert.match(motionSource, /translate3d\(\$\{deltaX\}px, \$\{deltaY\}px, 0\)/)
  // Widths ease through CSS instead, and hold while the pointer is over the strip.
  assert.match(source, /if \(!stripSizing\.current\.overflowing\) setFrozenTabWidth\(stripSizing\.current\.tabWidth\)/)
  assert.match(source, /onPointerLeave=\{\(\) => setFrozenTabWidth\(null\)\}/)
  assert.match(source, /let idle = window\.setTimeout\(release, 2_500\)/)
  assert.match(readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), /\.horizontal-tab \{\n  transition: width 170ms/)
})
