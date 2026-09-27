import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../scripts/icloud-passwords-smoke.cjs', import.meta.url), 'utf8')

test('iCloud structural smoke stays isolated from the authenticated profile', () => {
  assert.match(source, /profiles', 'icloud-smoke'/)
  assert.match(source, /VAST_ICLOUD_SMOKE_PROFILE/)
  assert.doesNotMatch(source, /profiles', 'icloud'\)/)
})

test('iCloud structural smoke requires a newly observed Apple helper process', () => {
  assert.match(source, /const initialHostPids = appleHostPids\(\)/)
  assert.match(source, /!initialHostPids\.has\(pid\)/)
})
