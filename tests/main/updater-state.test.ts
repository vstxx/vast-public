import assert from 'node:assert/strict'
import test from 'node:test'

import { createUpdaterStateMachine } from '../../src/main/updater-state.ts'

test('updater install is allowed only when update is ready', () => {
  const machine = createUpdaterStateMachine()
  assert.equal(machine.snapshot().state, 'disabled')
  assert.throws(() => machine.assertInstallAllowed(), /not ready/i)

  machine.transition('checking')
  machine.transition('available')
  machine.transition('downloading')
  assert.throws(() => machine.assertInstallAllowed(), /not ready/i)

  machine.transition('ready', { version: '1.0.10' })
  assert.doesNotThrow(() => machine.assertInstallAllowed())
})

test('updater state stores redacted errors', () => {
  const machine = createUpdaterStateMachine()
  machine.transition('error', { error: 'C:\\Users\\alice\\token=secret\\file?signature=abc' })
  assert.equal(machine.snapshot().state, 'error')
  assert.match(machine.snapshot().lastError ?? '', /\[path\]/)
  assert.doesNotMatch(machine.snapshot().lastError ?? '', /secret|abc/)
})
