import assert from 'node:assert/strict'
import test from 'node:test'
import { PasswordVaultSession } from '../../src/main/password-vault-session-policy.ts'

function fixture(): { session: PasswordVaultSession; advance: (milliseconds: number) => void } {
  let now = 1_000
  return {
    session: new PasswordVaultSession({
      now: () => now,
      sessionTimeoutMs: 10_000,
      idleTimeoutMs: 3_000,
      freshUnlockMs: 1_000
    }),
    advance: (milliseconds) => { now += milliseconds }
  }
}

test('password vault starts locked and unlock creates bounded session deadlines', () => {
  const { session } = fixture()
  assert.deepEqual(session.status(), { locked: true, reason: 'startup' })
  const unlocked = session.unlock()
  assert.equal(unlocked.locked, false)
  assert.equal(unlocked.expiresAt, 11_000)
  assert.equal(unlocked.idleExpiresAt, 4_000)
  assert.equal(unlocked.freshUntil, 2_000)
})

test('vault locks after inactivity and after the absolute session timeout', () => {
  const idle = fixture()
  idle.session.unlock()
  idle.advance(3_001)
  assert.deepEqual(idle.session.status(), { locked: true, reason: 'idle' })

  const absolute = fixture()
  absolute.session.unlock()
  for (let index = 0; index < 4; index += 1) {
    absolute.advance(2_500)
    if (index < 3) absolute.session.requireUnlocked()
  }
  assert.deepEqual(absolute.session.status(), { locked: true, reason: 'session-expired' })
})

test('fresh-only actions fail closed and force a new unlock', () => {
  const { session, advance } = fixture()
  session.unlock()
  session.requireFreshUnlock()
  advance(1_001)
  assert.throws(() => session.requireFreshUnlock(), /fresh unlock/)
  assert.deepEqual(session.status(), { locked: true, reason: 'session-expired' })
})

test('system idle and explicit system locks clear the session immediately', () => {
  const { session } = fixture()
  session.unlock()
  assert.deepEqual(session.lockIfSystemIdle(4), { locked: true, reason: 'idle' })
  session.unlock()
  assert.deepEqual(session.lock('system-lock'), { locked: true, reason: 'system-lock' })
})
