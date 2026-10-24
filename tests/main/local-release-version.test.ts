import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { validateReleaseFileEnv } = require('../../scripts/local-public-release.cjs') as {
  validateReleaseFileEnv: (parsed: Record<string, string>, version: string, sourceCommit: string) => void
}
const sourceCommit = 'a'.repeat(40)

test('0.5.5 Direct release accepts the public 0.5.0 upgrade baseline', () => {
  assert.doesNotThrow(() => validateReleaseFileEnv({ VAST_PREVIOUS_VERSION: '0.5.0' }, '0.5.5', sourceCommit))
  assert.throws(() => validateReleaseFileEnv({ VAST_PREVIOUS_VERSION: '0.3.0' }, '0.5.5', sourceCommit))
})
