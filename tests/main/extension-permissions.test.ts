import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveNativeGrants, hasPendingNativePermissions } from '../../src/main/extensions/extension-permissions.ts'
import { readFileSync } from 'node:fs'

const managerSource = readFileSync(new URL('../../src/main/extensions/extension-manager.ts', import.meta.url), 'utf8')
const brokerSource = readFileSync(new URL('../../src/main/extensions/extension-capability-broker.ts', import.meta.url), 'utf8')

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

test('tab metadata and tab events require the explicit read-tabs grant', () => {
  assert.match(brokerSource, /'tabs\.query': 'vast\.tabs\.read'/)
  assert.match(brokerSource, /'tabs\.get': 'vast\.tabs\.read'/)
  assert.match(brokerSource, /'tabs\.create': 'vast\.tabs\.write'/)
  assert.match(brokerSource, /manifest\.vast\?\.permissions\.includes\(permission\).*record\.grantedPermissions\.includes\(permission\)/)
  assert.match(managerSource, /record\.enabled && record\.grantedPermissions\.includes\('vast\.tabs\.read'\)/)
})

test('Hub updates with new permissions stop for fresh user consent', () => {
  assert.match(managerSource, /hasPermissionEscalation\(escalation\)/)
  assert.match(managerSource, /updateState: 'pending-approval'/)
  assert.match(managerSource, /approveUpdate\(extensionId: string\)/)
})
