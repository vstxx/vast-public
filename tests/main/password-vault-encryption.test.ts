import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { vaultStorageBackendIsSecure } from '../../src/main/password-vault-crypto-policy.ts'

const vaultSource = readFileSync(new URL('../../src/main/password-vault.ts', import.meta.url), 'utf8')

test('vault refuses Linux safeStorage basic_text while allowing OS-backed stores', () => {
  assert.equal(vaultStorageBackendIsSecure('linux', true, 'basic_text'), false)
  assert.equal(vaultStorageBackendIsSecure('linux', true, 'gnome_libsecret'), true)
  assert.equal(vaultStorageBackendIsSecure('win32', true, undefined), true)
  assert.equal(vaultStorageBackendIsSecure('darwin', false, undefined), false)
  assert.match(vaultSource, /safeStorage\.getSelectedStorageBackend\(\)/)
  assert.match(vaultSource, /Refusing to use Electron safeStorage with the insecure Linux basic_text backend/)
})

test('vault v2 stores username and notes only as safeStorage ciphertext', () => {
  assert.match(vaultSource, /schemaVersion: 2/)
  assert.match(vaultSource, /encryptedUsername: encryptVaultField\(normalized\.username\)/)
  assert.match(vaultSource, /encryptedNotes: normalized\.notes === undefined \? undefined : encryptVaultField\(normalized\.notes\)/)
  assert.match(vaultSource, /next\.encryptedUsername = encryptVaultField/)
  assert.match(vaultSource, /next\.encryptedNotes = encryptVaultField/)
  const storedRecord = vaultSource.match(/const record: EncryptedPasswordRecord = \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.doesNotMatch(storedRecord, /\n\s+username:/)
  assert.doesNotMatch(storedRecord, /\n\s+notes:/)
})

test('legacy vault records are migrated and plaintext fields are omitted from normalized records', () => {
  assert.match(vaultSource, /parsed\.schemaVersion !== 1 && parsed\.schemaVersion !== 2/)
  assert.match(vaultSource, /if \(migrationRequired\)/)
  assert.match(vaultSource, /decryptVaultField\(encryptedPassword, 'password'\)/)
  assert.match(vaultSource, /encryptVaultField\(legacyUsername\)/)
  assert.match(vaultSource, /legacyNotes === undefined \? undefined : encryptVaultField\(legacyNotes\)/)
  assert.match(vaultSource, /normalizedRecords\.some\(\(\{ migrated \}\) => migrated\)\) await saveVault\(nextVault\)/)
})
