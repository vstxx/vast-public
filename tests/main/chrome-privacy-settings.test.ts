import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChromePrivacySettingsStore } from '../../src/main/extensions/chrome-privacy-settings.ts'

const EXTENSION_A = 'a'.repeat(32)
const EXTENSION_B = 'b'.repeat(32)

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vast-chrome-privacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('a setting survives restart and reports its controlling extension', async (t) => {
  const root = await temporaryRoot(t)
  const statePath = join(root, 'privacy.json')
  const first = new ChromePrivacySettingsStore(statePath)

  await first.set(EXTENSION_A, 'services.passwordSavingEnabled', false)

  const restarted = new ChromePrivacySettingsStore(statePath)
  const details = await restarted.get(EXTENSION_A, 'services.passwordSavingEnabled')
  assert.deepEqual({ ...details, updatedAt: undefined }, {
    value: false,
    controllerExtensionId: EXTENSION_A,
    updatedAt: undefined,
    levelOfControl: 'controlled_by_this_extension'
  })
  assert.equal(typeof details.updatedAt, 'string')
})

test('another extension cannot clear a setting it does not control', async (t) => {
  const root = await temporaryRoot(t)
  const store = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
  await store.set(EXTENSION_A, 'services.autofillAddressEnabled', false)

  await assert.rejects(
    store.clear(EXTENSION_B, 'services.autofillAddressEnabled'),
    /controlled by another extension/
  )
  assert.equal((await store.get(EXTENSION_A, 'services.autofillAddressEnabled')).value, false)
})

test('invalid extension IDs, keys and values are rejected before mutation', async (t) => {
  const root = await temporaryRoot(t)
  const statePath = join(root, 'privacy.json')
  const store = new ChromePrivacySettingsStore(statePath)

  await assert.rejects(
    store.set('invalid', 'services.passwordSavingEnabled', false),
    /Invalid Chrome extension ID/
  )
  await assert.rejects(
    store.set(EXTENSION_A, 'network.webRTCIPHandlingPolicy' as never, false),
    /Unsupported Chrome privacy setting/
  )
  await assert.rejects(
    store.set(EXTENSION_A, 'services.passwordSavingEnabled', 'false' as unknown as boolean),
    /must be boolean/
  )
  await assert.rejects(readFile(statePath, 'utf8'), { code: 'ENOENT' })
})

test('malformed or unsupported persisted state fails closed and is not overwritten', async (t) => {
  const root = await temporaryRoot(t)
  const statePath = join(root, 'privacy.json')
  const malformed = JSON.stringify({ schemaVersion: 2, settings: {} })
  await writeFile(statePath, malformed, 'utf8')
  const store = new ChromePrivacySettingsStore(statePath)

  await assert.rejects(
    store.set(EXTENSION_A, 'services.passwordSavingEnabled', false),
    /state is malformed/
  )
  assert.equal(await readFile(statePath, 'utf8'), malformed)
})

test('a failed atomic write leaves the previously committed state readable', async (t) => {
  const root = await temporaryRoot(t)
  const statePath = join(root, 'privacy.json')
  await new ChromePrivacySettingsStore(statePath)
    .set(EXTENSION_A, 'services.passwordSavingEnabled', false)
  const failed = new ChromePrivacySettingsStore(statePath, {
    writeState: async () => { throw new Error('simulated atomic write failure') }
  })

  await assert.rejects(
    failed.set(EXTENSION_A, 'services.passwordSavingEnabled', true),
    /simulated atomic write failure/
  )
  const restarted = new ChromePrivacySettingsStore(statePath)
  assert.equal((await restarted.get(EXTENSION_A, 'services.passwordSavingEnabled')).value, false)
})

test('the last authorized writer controls one key and its clear restores the default', async (t) => {
  const root = await temporaryRoot(t)
  const store = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
  await store.set(EXTENSION_A, 'services.autofillCreditCardEnabled', false)
  await store.set(EXTENSION_B, 'services.autofillCreditCardEnabled', true)

  assert.equal(
    (await store.get(EXTENSION_A, 'services.autofillCreditCardEnabled')).levelOfControl,
    'controlled_by_other_extensions'
  )
  assert.equal(
    (await store.get(EXTENSION_B, 'services.autofillCreditCardEnabled')).levelOfControl,
    'controlled_by_this_extension'
  )
  assert.deepEqual(await store.clear(EXTENSION_B, 'services.autofillCreditCardEnabled'), {
    value: true,
    levelOfControl: 'controllable_by_this_extension'
  })
})

test('subscriptions receive committed changes only until unsubscribe', async (t) => {
  const root = await temporaryRoot(t)
  const store = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
  const changes: unknown[] = []
  const unsubscribe = store.subscribe((change) => changes.push(change))

  await store.set(EXTENSION_A, 'services.passwordSavingEnabled', false)
  unsubscribe()
  await store.clear(EXTENSION_A, 'services.passwordSavingEnabled')

  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], {
    key: 'services.passwordSavingEnabled',
    details: {
      value: false,
      controllerExtensionId: EXTENSION_A,
      updatedAt: (changes[0] as { details: { updatedAt: string } }).details.updatedAt,
      levelOfControl: 'controlled_by_this_extension'
    }
  })
})

test('removing an extension clears only settings it controls', async (t) => {
  const root = await temporaryRoot(t)
  const store = new ChromePrivacySettingsStore(join(root, 'privacy.json'))
  await store.set(EXTENSION_A, 'services.passwordSavingEnabled', false)
  await store.set(EXTENSION_A, 'services.autofillAddressEnabled', false)
  await store.set(EXTENSION_B, 'services.autofillCreditCardEnabled', false)

  await store.removeExtension(EXTENSION_A)

  assert.equal((await store.get(EXTENSION_A, 'services.passwordSavingEnabled')).value, true)
  assert.equal((await store.get(EXTENSION_A, 'services.autofillAddressEnabled')).value, true)
  assert.equal(
    (await store.get(EXTENSION_B, 'services.autofillCreditCardEnabled')).levelOfControl,
    'controlled_by_this_extension'
  )
})

test('separate state paths never share setting state', async (t) => {
  const root = await temporaryRoot(t)
  const first = new ChromePrivacySettingsStore(join(root, 'first.json'))
  const second = new ChromePrivacySettingsStore(join(root, 'second.json'))
  await first.set(EXTENSION_A, 'services.passwordSavingEnabled', false)

  assert.equal((await second.get(EXTENSION_A, 'services.passwordSavingEnabled')).value, true)
  assert.equal(
    (await second.get(EXTENSION_A, 'services.passwordSavingEnabled')).levelOfControl,
    'controllable_by_this_extension'
  )
})
