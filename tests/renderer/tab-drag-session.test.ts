import assert from 'node:assert/strict'
import test from 'node:test'
import { beginTabDrag, consumeTabDrop, recordTabDrop } from '../../src/renderer/lib/tab-drag-session.ts'

function transfer(): DataTransfer {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'none',
    setData: (type: string, value: string) => { values.set(type, value) },
    getData: (type: string) => values.get(type) ?? ''
  } as DataTransfer
}

test('a successful tab drop cannot be mistaken for a tear out', () => {
  const data = transfer()
  beginTabDrag('tab-one', data)
  assert.equal(data.effectAllowed, 'move')
  assert.equal(data.getData('text/plain'), 'tab-one')
  recordTabDrop('tab-one')
  assert.equal(consumeTabDrop('tab-one'), true)
  assert.equal(consumeTabDrop('tab-one'), false)
})

test('a drag without a matching tab drop still permits tear out', () => {
  beginTabDrag('tab-one', transfer())
  recordTabDrop('tab-two')
  assert.equal(consumeTabDrop('tab-one'), false)
  beginTabDrag('tab-two', transfer())
  assert.equal(consumeTabDrop('tab-two'), false)
})
