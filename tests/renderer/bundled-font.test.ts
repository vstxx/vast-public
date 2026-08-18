import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const rendererCss = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

test('the renderer registers every bundled Inter face under the shared UI family', () => {
  const registeredFaces = rendererCss.match(/font-family:\s*'Inter';/g) ?? []

  assert.equal(registeredFaces.length, 5)
  assert.doesNotMatch(rendererCss, /font-family:\s*'InterDisplay';/)
  assert.match(rendererCss, /--vast-font:\s*'Inter',\s*ui-sans-serif/)
})
