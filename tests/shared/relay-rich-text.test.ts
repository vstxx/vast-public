import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRelayRichText, parseRelayRichTextInline } from '../../src/shared/relay-rich-text.ts'

test('Relay rich text parses the bounded announcement formatting model', () => {
  const blocks = parseRelayRichText(`# Highlights

Vast is **faster** and *calmer* with \`safe code\`.

- First change
- Second change

1. Restart Vast
2. Enjoy

> Signed data, rendered locally.

---

\`\`\`
npm run build
\`\`\``)

  assert.deepEqual(blocks.map((block) => block.kind), [
    'heading', 'paragraph', 'unordered-list', 'ordered-list', 'quote', 'divider', 'code-block'
  ])
  const paragraph = blocks[1]
  assert.equal(paragraph.kind, 'paragraph')
  if (paragraph.kind === 'paragraph') {
    assert.deepEqual(paragraph.content.map((node) => node.kind), ['text', 'strong', 'text', 'emphasis', 'text', 'code', 'text'])
  }
})

test('Relay rich text keeps HTML and unsupported markup as inert text', () => {
  const inline = parseRelayRichTextInline('<script>alert(1)</script> [link](javascript:alert(1))')
  assert.deepEqual(inline, [{ kind: 'text', value: '<script>alert(1)</script> [link](javascript:alert(1))' }])
  assert.equal(JSON.stringify(parseRelayRichText('<img src=x onerror=alert(1)>')).includes('html'), false)
})
