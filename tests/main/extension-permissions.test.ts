import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveNativeGrants, hasPendingNativePermissions } from '../../src/main/extensions/extension-permissions.ts'

test('requested permissions and persisted grants remain separate', () => {
  assert.deepEqual(effectiveNativeGrants(['vast.storage', 'vast.toolbar'], ['vast.storage']), ['vast.storage'])
  assert.equal(hasPendingNativePermissions(['vast.storage', 'vast.toolbar'], ['vast.storage']), true)
  assert.equal(hasPendingNativePermissions(['vast.storage'], ['vast.storage', 'vast.tabs.read']), false)
})

test('reload permission escalation is pending and removed permissions lose effective grants', () => {
  const oldRequested = ['vast.storage'] as const
  const persisted = ['vast.storage'] as const
  assert.equal(hasPendingNativePermissions(oldRequested, persisted), false)
  const escalated = ['vast.storage', 'vast.tabs.read'] as const
  assert.equal(hasPendingNativePermissions(escalated, persisted), true)
  assert.deepEqual(effectiveNativeGrants(['vast.storage'], ['vast.storage', 'vast.tabs.read']), ['vast.storage'])
})
