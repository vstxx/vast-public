import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const coordinatorSource = readFileSync(new URL('../../src/main/windows/WindowCloseCoordinator.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')

test('window close is prevented until the renderer acknowledges final persistence', () => {
  assert.match(coordinatorSource, /window\.on\('close'/)
  assert.match(coordinatorSource, /event\.preventDefault\(\)/)
  assert.match(coordinatorSource, /vast:window:prepare-close/)
  assert.match(coordinatorSource, /CLOSE_FLUSH_TIMEOUT_MS/)
  assert.match(coordinatorSource, /window\.destroy\(\)/)
})

test('failed or timed-out saves offer retry, explicit fallback, and cancel', () => {
  assert.match(coordinatorSource, /Retry save/)
  assert.match(coordinatorSource, /Close without saving/)
  assert.match(coordinatorSource, /Cancel close/)
})

test('close acknowledgements are bound to the requesting renderer', () => {
  assert.match(coordinatorSource, /request\.window\.webContents !== sender/)
  assert.match(ipcSource, /vast:window:close-ready/)
  assert.match(ipcSource, /windowCloseCoordinator\.resolve\(event\.sender/)
})

test('detached windows await final tab synchronization in the same handshake', () => {
  assert.match(appSource, /onPrepareClose[\s\S]*await window\.vast\.browser\.syncDetachedTab/)
  assert.match(appSource, /if \(!result\.ok\) throw new Error/)
})
