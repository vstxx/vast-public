import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('../../src/shared/types.ts', import.meta.url), 'utf8')

test('Windows uses Vast-owned controls instead of the native titlebar overlay', () => {
  assert.match(windowSource, /titleBarOverlay:\s*process\.platform === 'win32'\s*\? false/)
  assert.match(windowSource, /vast:window:state-changed/)
  assert.match(windowSource, /mainWindow\.on\('maximize', publishWindowState\)/)
  assert.match(windowSource, /mainWindow\.on\('unmaximize', publishWindowState\)/)
})

test('window actions cross the trusted preload boundary and target only the sender window', () => {
  for (const channel of ['state', 'minimize', 'toggle-maximize', 'close']) {
    assert.match(ipcSource, new RegExp(`handle\\('vast:window:${channel}'`))
    assert.match(preloadSource, new RegExp(`vast:window:${channel}`))
  }
  assert.match(ipcSource, /senderWindowFor\(event\)\.minimize\(\)/)
  assert.match(ipcSource, /if \(window\.isMaximized\(\)\) window\.unmaximize\(\)/)
  assert.match(ipcSource, /if \(!window\.isDestroyed\(\)\) window\.close\(\)/)
  assert.match(typesSource, /onStateChanged: \(callback: \(state: WindowFrameState\)/)
})
