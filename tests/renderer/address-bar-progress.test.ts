import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const addressBarSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')

test('address bar loading progress remains visible through completion', () => {
  assert.match(addressBarSource, /showLoadingProgress/)
  assert.match(addressBarSource, /activeTab\.status === 'loading' \|\| activeTab\.progress > 0/)
  assert.doesNotMatch(addressBarSource, /\{activeTab\?\.status === 'loading' && \(/)
})

test('address bar loading progress spans the full browser row', () => {
  assert.match(addressBarSource, /absolute bottom-0 left-0 right-0 h-px/)
  assert.match(addressBarSource, /transform: `scaleX\(\$\{loadingProgress\}\)`/)
  assert.doesNotMatch(addressBarSource, /style=\{\{ width: `\$\{Math\.max\(activeTab\.progress \* 100, 12\)\}%` \}\}/)
})
