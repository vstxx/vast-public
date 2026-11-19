// Adapted from Glossa src/engine/text-prep.ts (MIT, SysAdminDoc), which follows Firefox's own
// `cleanText`: a soft hyphen comes back as garbage inside a word, Bergamot does not split CJK
// sentences when a quote follows the full stop, and edge whitespace confuses the model while the
// page needs its own spacing back exactly.

const SOFT_HYPHEN = /­/g
const WHITESPACE = /\s/
const CJK_SOURCES = new Set(['ja', 'ko', 'zh-Hans', 'zh-Hant'])
const CJK_SENTENCE_BEFORE_QUOTE = /([。！？])(?=["“‘「『])/g

export interface PreparedText {
  core: string
  lead: string
  trail: string
}

export function prepareForEngine(fragment: string, sourceLanguage: string): PreparedText {
  let start = 0
  let end = fragment.length
  while (start < end && WHITESPACE.test(fragment.charAt(start))) start++
  while (end > start && WHITESPACE.test(fragment.charAt(end - 1))) end--
  let core = fragment.slice(start, end).replace(SOFT_HYPHEN, '')
  if (CJK_SOURCES.has(sourceLanguage)) core = core.replace(CJK_SENTENCE_BEFORE_QUOTE, '$1 ')
  return { core, lead: fragment.slice(0, start), trail: fragment.slice(end) }
}

export function restoreEdges(output: string, prepared: PreparedText): string {
  const core = output.trim()
  return core ? `${prepared.lead}${core}${prepared.trail}` : ''
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
