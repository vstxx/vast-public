import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import test from 'node:test'

const source = readFileSync(new URL('../../src/renderer/components/new-tab/NewTabPage.tsx', import.meta.url), 'utf8')

test('new tab focuses the top address bar instead of the page search box', () => {
  assert.match(source, /runtime\.focusAddress\(\)/)
  assert.equal(source.includes('onSubmit={(value) => runtime.navigateActive(value)} autoFocus'), false)
})
