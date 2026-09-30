import assert from 'node:assert/strict'
import test from 'node:test'
import { electronFindOptions } from '../../src/shared/find-in-page.ts'

test('first find request starts a Chromium session on pinned Electron 44', () => {
  assert.deepEqual(electronFindOptions(), { forward: true, findNext: true })
  assert.deepEqual(electronFindOptions({ findNext: false }), { forward: true, findNext: true })
})

test('subsequent next and previous requests advance the existing session', () => {
  assert.deepEqual(electronFindOptions({ findNext: true }), { forward: true, findNext: false })
  assert.deepEqual(electronFindOptions({ findNext: true, forward: false }), { forward: false, findNext: false })
})
