import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientStorageReadError, readTextWithRetry } from '../../src/main/storage-read-retry.ts'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

test('storage reads retry transient filesystem failures with exponential backoff', async () => {
  let reads = 0
  const waits: number[] = []
  const text = await readTextWithRetry('vast-data.json', {
    read: async () => {
      reads += 1
      if (reads < 3) throw errno(reads === 1 ? 'EBUSY' : 'EACCES')
      return '{"schemaVersion":5}'
    },
    wait: async (ms) => { waits.push(ms) }
  })

  assert.equal(text, '{"schemaVersion":5}')
  assert.equal(reads, 3)
  assert.deepEqual(waits, [40, 80])
})

test('storage reads never retry non-transient failures', async () => {
  let reads = 0
  await assert.rejects(readTextWithRetry('vast-data.json', {
    read: async () => {
      reads += 1
      throw errno('EIO')
    },
    wait: async () => undefined
  }), { code: 'EIO' })
  assert.equal(reads, 1)
})

test('storage read retries are bounded and cover every audited transient code', async () => {
  for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE']) {
    assert.equal(isTransientStorageReadError(errno(code)), true)
  }

  let reads = 0
  await assert.rejects(readTextWithRetry('vast-data.json', {
    attempts: 3,
    read: async () => {
      reads += 1
      throw errno('EPERM')
    },
    wait: async () => undefined
  }), { code: 'EPERM' })
  assert.equal(reads, 3)
})
