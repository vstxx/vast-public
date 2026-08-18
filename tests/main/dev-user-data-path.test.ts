import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const dataPathSource = readFileSync(new URL('../../src/main/data-path.ts', import.meta.url), 'utf8')

test('development runs use an isolated user data directory', () => {
  assert.match(mainSource, /configureVastUserDataPath\(\)/)
  assert.match(dataPathSource, /VAST_DEV_USER_DATA_DIR/)
  assert.match(dataPathSource, /VAST_TEST_USER_DATA_DIR/)
  assert.match(dataPathSource, /Vast Dev/)
  assert.match(dataPathSource, /app\.setPath\('userData'/)
  assert.match(dataPathSource, /app\.setPath\('sessionData'/)
  assert.match(dataPathSource, /configuredRootSync/)
})
