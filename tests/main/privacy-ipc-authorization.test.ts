import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertGuestOwnedBySender } from '../../src/main/ipc/guest-ownership.ts'

test('guest ownership denies missing, destroyed, and cross-window targets', () => {
  assert.throws(() => assertGuestOwnedBySender(1, undefined), /unavailable/i)
  assert.throws(() => assertGuestOwnedBySender(1, { hostWebContents: { id: 1 }, isDestroyed: () => true }), /unavailable/i)
  assert.throws(() => assertGuestOwnedBySender(1, { hostWebContents: { id: 2 }, isDestroyed: () => false }), /outside this window/i)
  assert.throws(() => assertGuestOwnedBySender(1, { isDestroyed: () => false }), /outside this window/i)
  assert.doesNotThrow(() => assertGuestOwnedBySender(1, { hostWebContents: { id: 1 }, isDestroyed: () => false }))
})

test('every privacy IPC operation with a target resolves it against the caller', () => {
  const registrations = readFileSync(new URL('../../src/main/ipc/privacy.ts', import.meta.url), 'utf8')
  const wiring = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
  assert.match(wiring, /registerPrivacyIpc\(handle, resolveTrustedGuestWebContents\)/)
  for (const channel of ['clear-site-data', 'site-information', 'configure-identity']) {
    const handler = registrations.split(`handle('vast:privacy:${channel}'`)[1]?.split("handle('vast:privacy:")[0]
    assert.ok(handler, `${channel} handler exists`)
    assert.match(handler, /resolveOwnedGuest\(event\.sender, webContentsId\)/)
  }
})
