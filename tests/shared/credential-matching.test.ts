import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalCredentialUsername, resolveCredentialMatch, type CredentialMatchRecord } from '../../src/shared/credential-matching.ts'

const origin = 'https://example.com'
function record(id: string, username: string, password: string, lastUsedAt = 0): CredentialMatchRecord {
  return { id, origin, username, password, lastUsedAt }
}

test('canonical usernames are trimmed, Unicode-normalized and case-insensitive', () => {
  assert.equal(canonicalCredentialUsername('  USER@Example.COM  '), 'user@example.com')
  assert.equal(canonicalCredentialUsername('Ａlice'), 'alice')
})
test('unchanged passwords do not prompt or create duplicates', () => {
  assert.deepEqual(resolveCredentialMatch({ origin, username: 'ALICE', password: 'same', kind: 'login' }, [record('a', 'alice', 'same')]), {
    action: 'unchanged', recordId: 'a'
  })
})

test('changed passwords update the same canonical account', () => {
  assert.deepEqual(resolveCredentialMatch({ origin, username: ' Alice ', password: 'new', kind: 'login' }, [record('a', 'alice', 'old')]), {
    action: 'update', recordId: 'a'
  })
})

test('multiple accounts on one origin stay distinct', () => {
  assert.deepEqual(resolveCredentialMatch({ origin, username: 'bob', password: 'b2', kind: 'login' }, [
    record('a', 'alice', 'a1'), record('b', 'bob', 'b1')
  ]), { action: 'update', recordId: 'b' })
  assert.deepEqual(resolveCredentialMatch({ origin, username: 'charlie', password: 'c1', kind: 'signup' }, [
    record('a', 'alice', 'a1'), record('b', 'bob', 'b1')
  ]), { action: 'save' })
})

test('duplicate imported records resolve deterministically to the most recently used', () => {
  assert.deepEqual(resolveCredentialMatch({ origin, username: 'alice', password: 'next', kind: 'login' }, [
    record('old', 'Alice', 'one', 1), record('recent', 'alice', 'two', 10)
  ]), { action: 'update', recordId: 'recent' })
})

test('empty usernames never overwrite a named account', () => {
  assert.deepEqual(resolveCredentialMatch({ origin, username: '', password: 'new', kind: 'login' }, [record('a', 'alice', 'old')]), {
    action: 'ignore', reason: 'empty-username-ambiguous'
  })
  assert.deepEqual(resolveCredentialMatch({ origin, username: '', password: 'new', kind: 'login' }, [record('empty', '', 'old')]), {
    action: 'update', recordId: 'empty'
  })
})

test('password change resolves by explicit username and matching current password', () => {
  assert.deepEqual(resolveCredentialMatch({
    origin, username: 'alice', password: 'new', currentPassword: 'old', kind: 'change-password'
  }, [record('a', 'alice', 'old'), record('b', 'bob', 'other')]), { action: 'update', recordId: 'a' })
})

test('password change without a username resolves only an unambiguous current-password match', () => {
  assert.deepEqual(resolveCredentialMatch({
    origin, username: '', password: 'new', currentPassword: 'unique-old', kind: 'change-password'
  }, [record('a', 'alice', 'unique-old'), record('b', 'bob', 'other')]), { action: 'update', recordId: 'a' })
  assert.deepEqual(resolveCredentialMatch({
    origin, username: '', password: 'new', currentPassword: 'shared', kind: 'change-password'
  }, [record('a', 'alice', 'shared'), record('b', 'bob', 'shared')]), { action: 'ignore', reason: 'ambiguous-account' })
})

test('wrong current password never updates a stored credential', () => {
  assert.deepEqual(resolveCredentialMatch({
    origin, username: 'alice', password: 'new', currentPassword: 'wrong', kind: 'change-password'
  }, [record('a', 'alice', 'old')]), { action: 'ignore', reason: 'current-password-mismatch' })
})
