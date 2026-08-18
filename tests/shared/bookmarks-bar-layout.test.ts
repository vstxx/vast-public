import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateVisibleBookmarkCount } from '../../src/shared/bookmarks-bar-layout.ts'

test('bookmark bar measurement is skipped while the bar is hidden or not laid out', () => {
  assert.equal(calculateVisibleBookmarkCount({ barWidth: 0, itemWidths: [60, 80, 70] }), null)
  assert.equal(calculateVisibleBookmarkCount({ barWidth: 500, itemWidths: [0, 0, 0] }), null)
})

test('bookmark overflow appears only when items reach the end of the bar', () => {
  assert.equal(calculateVisibleBookmarkCount({ barWidth: 500, itemWidths: [60, 80, 70] }), 3)
  assert.equal(calculateVisibleBookmarkCount({ barWidth: 252, itemWidths: [120, 80, 20] }), 3)
  assert.equal(calculateVisibleBookmarkCount({ barWidth: 210, itemWidths: [60, 80, 70] }), 1)
})
