import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

test('the right-click menu has no link preview', () => {
  assert.doesNotMatch(read('components/ui/ContextMenu.tsx'), /preview/i)
  assert.doesNotMatch(read('components/browser/WebviewSurface.tsx'), /linkPreviewSite|preview:/)
  assert.doesNotMatch(read('store/browser-store.ts'), /preview\?: \{/)
  assert.doesNotMatch(read('styles/index.css'), /link-preview/)
})
