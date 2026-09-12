import test from 'node:test'
import assert from 'node:assert/strict'
import { isTrackerUrl } from '../../src/shared/tracker-policy.ts'

test('independent tracker protection matches whole HTTP host names', () => {
  assert.equal(isTrackerUrl('https://www.google-analytics.com/collect'), true)
  for (const url of ['https://mail.google.com', 'https://google-analytics.com.example.org', 'https://example.org/google-analytics.com', 'file:///google-analytics.com', 'invalid']) {
    assert.equal(isTrackerUrl(url), false)
  }
})
