export type RelayRichTextInline =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'emphasis'; value: string }
  | { kind: 'code'; value: string }

export type RelayRichTextBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; content: RelayRichTextInline[] }
  | { kind: 'paragraph'; content: RelayRichTextInline[] }
  | { kind: 'unordered-list'; items: RelayRichTextInline[][] }
  | { kind: 'ordered-list'; items: RelayRichTextInline[][] }
  | { kind: 'quote'; content: RelayRichTextInline[] }
  | { kind: 'code-block'; value: string }
  | { kind: 'divider' }

const INLINE_MARKUP = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g

export function parseRelayRichTextInline(value: string): RelayRichTextInline[] {
  const nodes: RelayRichTextInline[] = []
  let offset = 0
  for (const match of value.matchAll(INLINE_MARKUP)) {
    const index = match.index ?? 0
    if (index > offset) nodes.push({ kind: 'text', value: value.slice(offset, index) })
    const token = match[0]
    if (token.startsWith('`')) nodes.push({ kind: 'code', value: token.slice(1, -1) })
    else if (token.startsWith('**')) nodes.push({ kind: 'strong', value: token.slice(2, -2) })
    else nodes.push({ kind: 'emphasis', value: token.slice(1, -1) })
    offset = index + token.length
  }
  if (offset < value.length) nodes.push({ kind: 'text', value: value.slice(offset) })
  return nodes.length > 0 ? nodes : [{ kind: 'text', value }]
}

function startsBlock(line: string): boolean {
  return /^(?:#{1,3}\s+|```|\s*[-*]\s+|\s*\d+[.)]\s+|>\s?|---\s*$)/.test(line)
}

export function parseRelayRichText(value: string): RelayRichTextBlock[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const blocks: RelayRichTextBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    if (/^```/.test(line)) {
      index += 1
      const code: string[] = []
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code-block', value: code.join('\n') })
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        content: parseRelayRichTextInline(heading[2].trim())
      })
      index += 1
      continue
    }

    if (/^---\s*$/.test(line)) {
      blocks.push({ kind: 'divider' })
      index += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: RelayRichTextInline[][] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(parseRelayRichTextInline(lines[index].replace(/^\s*[-*]\s+/, '')))
        index += 1
      }
      blocks.push({ kind: 'unordered-list', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: RelayRichTextInline[][] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(parseRelayRichTextInline(lines[index].replace(/^\s*\d+[.)]\s+/, '')))
        index += 1
      }
      blocks.push({ kind: 'ordered-list', items })
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', content: parseRelayRichTextInline(quote.join(' ')) })
      continue
    }

    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', content: parseRelayRichTextInline(paragraph.join(' ')) })
  }

  return blocks
}
