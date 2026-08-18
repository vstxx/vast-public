import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestTaskQueue } from '../../src/main/latest-task-queue.ts'

test('rapid durable mutations retain the in-flight and newest state only', async () => {
  const seen: number[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = new LatestTaskQueue<number>(async (value) => {
    seen.push(value)
    if (value === 1) await firstGate
  })

  const first = queue.run(1)
  const second = queue.run(2)
  const third = queue.run(3)
  releaseFirst()
  await Promise.all([first, second, third])

  assert.deepEqual(seen, [1, 3])
})
