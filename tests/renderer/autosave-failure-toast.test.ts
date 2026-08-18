import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')

test('autosave failure stays visible and retries the latest snapshot', () => {
  assert.match(appSource, /id: failureToastId,[\s\S]*title: 'Vast could not save changes'/)
  assert.match(appSource, /durationMs: 0/)
  assert.match(appSource, /label: 'Retry'/)
  assert.match(appSource, /const latestPayload = useBrowserStore\.getState\(\)\.toPersistedData\(\)/)
  assert.match(appSource, /queuePersistedSaveRef\.current\(latestPayload, JSON\.stringify\(latestPayload\), reason\)/)
  assert.match(appSource, /lastSavedPayloadRef\.current = serialized[\s\S]*dismissToast\(failureToastId\)/)
})
