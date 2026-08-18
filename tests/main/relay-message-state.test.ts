import assert from 'node:assert/strict'
import test from 'node:test'
import { RelayMessageState, relayPresentation } from '../../src/main/relay/message-state.ts'
import { relayBroadcastFixture, relayFixtureKeys, relayReleaseFixture } from './relay-fixtures.ts'

test('Relay queues one presentation deterministically by severity, type, priority and ID', () => {
  const keys = relayFixtureKeys()
  const state = new RelayMessageState()
  const seasonal = keys.signPayload(relayBroadcastFixture())
  const security = keys.signPayload(relayBroadcastFixture({ id: '25c24f93-dca9-41a9-af99-f0bc91d5e943', type: 'security', priority: 1 }))
  const update = keys.signPayload(relayReleaseFixture({ severity: 'critical' }))
  state.replace([seasonal, security], update, new Set())
  assert.equal(state.pendingCount(), 3)
  assert.equal(state.current()?.presentationId, 'release:0.2.0')
  assert.equal(relayPresentation(state.current()!, null).kind, 'update')
  assert.equal(state.dismiss('broadcast:15c24f93-dca9-41a9-af99-f0bc91d5e943'), false)
  assert.equal(state.dismiss('release:0.2.0'), true)
  assert.equal(state.current()?.presentationId, 'broadcast:25c24f93-dca9-41a9-af99-f0bc91d5e943')
})

test('Relay filters locally dismissed and duplicate presentations without telemetry', () => {
  const keys = relayFixtureKeys()
  const state = new RelayMessageState()
  const message = keys.signPayload(relayBroadcastFixture())
  state.replace([message, message], null, new Set([`broadcast:${message.payload.id}`]))
  assert.equal(state.pendingCount(), 0)
})

