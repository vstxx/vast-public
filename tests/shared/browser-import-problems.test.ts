import assert from 'node:assert/strict'
import test from 'node:test'
import { browserImportProblemMessage } from '../../src/shared/browser-import.ts'

test('import failures explain retry without exposing source paths or data', () => {
  const message = browserImportProblemMessage({ status: 'failed', code: 'SOURCE_READ_FAILED' })
  assert.match(message, /close it and retry/i)
  assert.doesNotMatch(message, /[A-Z]:\\|https?:\/\//i)
  assert.match(browserImportProblemMessage({ status: 'failed', code: 'SOURCE_INVALID' }), /invalid or damaged/i)
})
