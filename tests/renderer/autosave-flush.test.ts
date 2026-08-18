import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')

test('main-owned close handshake requests and awaits the final renderer flush', () => {
  assert.match(appSource, /flushPendingSave/)
  assert.match(appSource, /onPrepareClose/)
  assert.match(appSource, /await window\.vast\.storage\.flush/)
  assert.match(appSource, /closeReady\(requestId/)
  assert.match(appSource, /pagehide/)
  assert.match(appSource, /visibilitychange/)
  assert.match(appSource, /window\.vast\.storage\.flush/)
})

test('preload exposes storage flush through the same main-process save path', () => {
  assert.match(preloadSource, /flush:/)
  assert.match(preloadSource, /vast:storage:flush/)
})
