import assert from 'node:assert/strict'
import test from 'node:test'

import { partitionForWorkspace, resolveWorkspaceIdentity } from '../../src/shared/workspace-identity.ts'

test('workspaces receive separate persistent cookie and storage partitions', () => {
  const personal = partitionForWorkspace({ id: 'personal', isPrivate: false })
  const school = partitionForWorkspace({ id: 'school', isPrivate: false })
  assert.equal(personal, 'persist:vast-workspace-personal')
  assert.equal(school, 'persist:vast-workspace-school')
  assert.notEqual(personal, school)
})

test('temporary identities are non-persistent and shared mode is explicit', () => {
  assert.equal(partitionForWorkspace({ id: 'temp', isPrivate: true }), 'vast-workspace-temp')
  assert.equal(partitionForWorkspace({ id: 'legacy', identity: { sessionMode: 'shared', proxyMode: 'system', proxyServer: '', proxyBypassRules: '<local>' } }), 'persist:vast-default')
  assert.equal(resolveWorkspaceIdentity({ id: 'private', isPrivate: true }).sessionMode, 'ephemeral')
})
