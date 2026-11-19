// Applies translations to the page and keeps what is needed to undo them without a reload.
// Restore bookkeeping is adapted from Glossa src/content/renderer.ts (MIT, SysAdminDoc).
//
// Model output is untrusted. It is parsed in an inert document and never inserted as markup. The
// live page receives only:
// - text nodes created from the output's text;
// - the page's own elements of the translated unit, matched by the number stamped on them before
//   the unit was sent (replace mode moves them, so their listeners, bindings and focus survive);
// - shallow copies of those page elements (bilingual mode, or an element the model repeated), with
//   ids and inline handlers removed;
// - copies of the unit's own protected content (translate="no", urls, numbers).
// Any element the output contains that the unit did not have, and every attribute the output
// carries, is dropped; its text is kept. Nothing from the model can add a script, a handler, a
// URL or a style to the page.

import {
  attributeMarker,
  clearIds,
  FORM_FIELD_SELECTOR,
  HOLD_ATTRIBUTE,
  ID_ATTRIBUTE,
  LABEL_MARKER,
  MARKER_SELECTOR,
  PAD_ATTRIBUTE,
  PARAGRAPH_TAGS,
  TRANSLATION_CLASS,
  TRANSLATION_TAG,
  UNIT_ATTRIBUTE,
  type Hold,
  type Segment
} from './segmenter.ts'
import { isRtlLanguage } from '../shared/languages.ts'
import type { DisplayMode } from '../shared/settings.ts'

export interface RenderOptions {
  displayMode: DisplayMode
  targetLanguage: string
}

interface ElementRecord {
  kind: 'element'
  element: Element
  originalChildren: Node[]
  reused: Array<{ element: Element; children: Node[]; writtenText: string }>
  writtenOwnText: string
  unrestorable: boolean
  previousLang: string | null
  previousDir: string | null
  appended: Element | null
  translatedText: string
  written: Node[]
}

interface TextRecord {
  kind: 'text'
  node: Text
  originalData: string
  translated: string
  appended: Element | null
}

interface AttributeRecord {
  kind: 'attribute'
  element: Element
  attribute: string
  original: string
  translated: string
}

interface LabelRecord {
  kind: 'label'
  element: Element
  original: string
  translated: string
  addedValue: boolean
}

type RenderRecord = ElementRecord | TextRecord | AttributeRecord | LabelRecord

const parser = new DOMParser()
const WORD_EDGE = /[\p{L}\p{N}]/u
const HANDLER = /^on/i

// Bergamot copies code, kbd, samp and var through verbatim but drops the whitespace around them.
// A placeholder records whether the source had a space on each side.
export function repairInlineSpacing(root: ParentNode): void {
  for (const element of root.querySelectorAll('code, kbd, samp, var')) {
    const pad = element.getAttribute(PAD_ATTRIBUTE)
    const left = pad === null || pad.includes('l')
    const right = pad === null || pad.includes('r')
    const previous = element.previousSibling
    if (left && previous?.nodeType === Node.TEXT_NODE) {
      const text = previous as Text
      if (text.data && WORD_EDGE.test(text.data.slice(-1))) text.data += ' '
    }
    const next = element.nextSibling
    if (right && next?.nodeType === Node.TEXT_NODE) {
      const text = next as Text
      if (text.data && WORD_EDGE.test(text.data.charAt(0))) text.data = ` ${text.data}`
    }
  }
}

// Text of untrusted markup, without inserting it anywhere.
export function plainText(html: string): string {
  if (!/[<&]/.test(html)) return html
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  repairInlineSpacing(doc.body)
  return doc.body.textContent ?? ''
}

function safeShallowCopy(original: Element): Element {
  const copy = original.cloneNode(false) as Element
  for (const attribute of Array.from(copy.attributes)) {
    if (attribute.name === 'id' || attribute.name === ID_ATTRIBUTE || HANDLER.test(attribute.name)) copy.removeAttribute(attribute.name)
  }
  return copy
}

function safeDeepCopy(original: Node): Node {
  const copy = original.cloneNode(true)
  const elements: Element[] = []
  if (copy.nodeType === Node.ELEMENT_NODE) elements.push(copy as Element)
  if (copy.nodeType === Node.ELEMENT_NODE || copy.nodeType === Node.DOCUMENT_FRAGMENT_NODE) elements.push(...(copy as ParentNode).querySelectorAll('*'))
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'id' || attribute.name === ID_ATTRIBUTE || HANDLER.test(attribute.name)) element.removeAttribute(attribute.name)
    }
  }
  return copy
}

interface BuildContext {
  mode: 'replace' | 'copy'
  unit: Element
  live: Map<string, Element>
  before: Map<Element, Node[]>
  holds: Hold[]
  used: Set<string>
  placedHolds: Set<number>
  reused: Array<{ element: Element; children: Node[] }>
}

// Turns the inert parse of the output into live nodes, by the rules at the top of this file.
function build(source: Node, context: BuildContext): Node[] {
  const out: Node[] = []
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(document.createTextNode((child as Text).data))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    if (element.tagName === 'VAR' && element.hasAttribute(HOLD_ATTRIBUTE)) {
      const index = Number(element.getAttribute(HOLD_ATTRIBUTE))
      const original = Number.isInteger(index) ? context.holds[index] : undefined
      if (!original) {
        out.push(document.createTextNode(element.textContent ?? ''))
        continue
      }
      // The page's own protected element moves back on first use in replace mode; anything else
      // (a repeat, a copy, a run of text) is a copy of what the page had.
      const live = original.nodeType === Node.ELEMENT_NODE && context.mode === 'replace' && !context.placedHolds.has(index) && context.unit.contains(original)
      context.placedHolds.add(index)
      out.push(live ? original : safeDeepCopy(original))
      continue
    }
    const children = build(element, context)
    const id = element.getAttribute(ID_ATTRIBUTE)
    const target = id === null ? undefined : context.live.get(id)
    if (!target) {
      // The unit had no such element: keep the words, drop the element and its attributes.
      out.push(...children)
      continue
    }
    if (target.matches(FORM_FIELD_SELECTOR)) {
      // A live field goes back in its slot once, untouched; it went to the engine empty.
      if (context.mode === 'replace' && !context.used.has(id!)) {
        context.used.add(id!)
        out.push(target)
      }
      continue
    }
    if (context.mode === 'replace' && !context.used.has(id!)) {
      context.used.add(id!)
      context.reused.push({ element: target, children: context.before.get(target) ?? Array.from(target.childNodes) })
      target.replaceChildren(...children)
      out.push(target)
      continue
    }
    const copy = safeShallowCopy(target)
    copy.append(...children)
    out.push(copy)
  }
  return out
}

function translateUnit(unit: Element, html: string, holds: Hold[], mode: 'replace' | 'copy'): { nodes: Node[]; reused: Array<{ element: Element; children: Node[] }> } {
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  repairInlineSpacing(doc.body)
  const live = new Map<string, Element>()
  const before = new Map<Element, Node[]>()
  for (const candidate of unit.querySelectorAll(`[${ID_ATTRIBUTE}]`)) {
    const id = candidate.getAttribute(ID_ATTRIBUTE)
    if (id === null) continue
    live.set(id, candidate)
    before.set(candidate, Array.from(candidate.childNodes))
  }
  const context: BuildContext = { mode, unit, live, before, holds, used: new Set(), placedHolds: new Set(), reused: [] }
  const nodes = build(doc.body, context)
  if (mode === 'replace') {
    // An element whose tags the engine dropped is not reused, but its children may have moved;
    // restoring must give those back too.
    const reusedSet = new Set(context.reused.map((entry) => entry.element))
    for (const [element, children] of before) {
      if (reusedSet.has(element)) continue
      const now = element.childNodes
      if (now.length !== children.length || children.some((child, index) => now[index] !== child)) context.reused.push({ element, children })
    }
  }
  return { nodes, reused: context.reused }
}

function labelLanguage(element: Element, language: string): void {
  element.setAttribute('lang', language)
  element.setAttribute('dir', isRtlLanguage(language) ? 'rtl' : 'ltr')
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

function ownText(root: Element, nested: Set<Element>): string {
  let text = ''
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let inside = false
    for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (nested.has(parent)) {
        inside = true
        break
      }
    }
    if (!inside) text += (node as Text).data
  }
  return text
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

// What the page did to a unit translated in place: nothing, changed the insides of reused elements
// (carried back on restore), or edited the translation itself (left as it is).
function pageEdit(record: ElementRecord): 'none' | 'reused' | 'translation' {
  const element = record.element
  const now = element.textContent ?? ''
  if (sameText(now, record.translatedText)) return 'none'
  if (record.written.some((node) => element.contains(node))) {
    const reusedSet = new Set(record.reused.map((entry) => entry.element))
    return ownText(element, reusedSet) === record.writtenOwnText ? 'reused' : 'translation'
  }
  const written = new Map<string, number>()
  for (const word of words(record.translatedText)) written.set(word, (written.get(word) ?? 0) + 1)
  const current = words(now)
  if (written.size < 3 || current.length === 0) return 'none'
  let shared = 0
  for (const word of current) {
    const left = written.get(word) ?? 0
    if (left > 0) {
      shared += 1
      written.set(word, left - 1)
    }
  }
  return shared / current.length >= 0.75 ? 'translation' : 'none'
}

function fieldsSurvive(nodes: Node[], unit: Element): boolean {
  const fields = Array.from(unit.querySelectorAll(FORM_FIELD_SELECTOR))
  return fields.every((field) => nodes.some((node) => node === field || node.contains(field)))
}

function wantsBilingual(element: Element, text: string): boolean {
  return PARAGRAPH_TAGS.has(element.tagName) ? text.trim().length >= 12 : text.trim().length >= 60
}

function hideDuplicateFromScreenReaders(block: Element): void {
  if (!block.querySelector('a[href], button, input, select, textarea, [tabindex], [contenteditable]')) block.setAttribute('aria-hidden', 'true')
}

function dropFormControls(block: Element): void {
  for (const field of block.querySelectorAll(FORM_FIELD_SELECTOR)) field.remove()
  for (const button of block.querySelectorAll('button')) button.replaceWith(...Array.from(button.childNodes))
}

export class Renderer {
  private readonly records: RenderRecord[] = []

  get count(): number {
    return this.records.length
  }

  markPending(segment: Segment): void {
    if (segment.kind === 'element') segment.element.setAttribute(UNIT_ATTRIBUTE, 'pending')
  }

  unmark(segment: Segment): void {
    if (segment.kind === 'element' && segment.element.getAttribute(UNIT_ATTRIBUTE) === 'pending') segment.element.removeAttribute(UNIT_ATTRIBUTE)
  }

  // Returns the plain text written, so the caller never sends its own output back to the engine.
  apply(segment: Segment, translated: string, options: RenderOptions): string | null {
    if (!translated.trim()) {
      this.unmark(segment)
      return null
    }
    if (segment.kind === 'attribute') return this.applyAttribute(segment, translated)
    if (segment.kind === 'label') return this.applyLabel(segment, translated)
    if (segment.kind === 'text') return this.applyText(segment, plainText(translated), options)
    const element = segment.element
    if (!element.isConnected) return null
    if (options.displayMode === 'bilingual' && wantsBilingual(element, segment.text)) return this.applyCopy(segment, translated, options)
    const originalChildren = Array.from(element.childNodes)
    const { nodes, reused } = translateUnit(element, translated, segment.holds, 'replace')
    // A live field the engine dropped would vanish from the page: show a copy below instead and
    // leave the unit exactly as it was.
    if (!fieldsSurvive(nodes, element)) {
      for (const entry of reused) entry.element.replaceChildren(...entry.children)
      element.replaceChildren(...originalChildren)
      return this.applyCopy(segment, translated, options)
    }
    element.replaceChildren(...nodes)
    const reusedSet = new Set(reused.map((entry) => entry.element))
    const applied = element.textContent ?? ''
    const previousLang = element.getAttribute('lang')
    const previousDir = element.getAttribute('dir')
    element.setAttribute(UNIT_ATTRIBUTE, 'replaced')
    labelLanguage(element, options.targetLanguage)
    this.records.push({
      kind: 'element',
      element,
      originalChildren,
      reused: reused.map((entry) => ({ ...entry, writtenText: ownText(entry.element, reusedSet) })),
      writtenOwnText: ownText(element, reusedSet),
      unrestorable: false,
      previousLang,
      previousDir,
      appended: null,
      translatedText: applied,
      written: nodes
    })
    return applied
  }

  private applyCopy(segment: Extract<Segment, { kind: 'element' }>, translated: string, options: RenderOptions): string | null {
    const element = segment.element
    const { nodes } = translateUnit(element, translated, segment.holds, 'copy')
    const block = document.createElement(TRANSLATION_TAG.toLowerCase())
    block.className = TRANSLATION_CLASS
    labelLanguage(block, options.targetLanguage)
    block.append(...nodes)
    clearIds(block)
    dropFormControls(block)
    hideDuplicateFromScreenReaders(block)
    element.append(block)
    element.setAttribute(UNIT_ATTRIBUTE, 'bilingual')
    const applied = block.textContent ?? ''
    this.records.push({
      kind: 'element',
      element,
      originalChildren: [],
      reused: [],
      writtenOwnText: '',
      unrestorable: false,
      previousLang: element.getAttribute('lang'),
      previousDir: element.getAttribute('dir'),
      appended: block,
      translatedText: applied,
      written: []
    })
    return applied
  }

  private applyAttribute(segment: Extract<Segment, { kind: 'attribute' }>, translated: string): string | null {
    const element = segment.element
    if (!element.isConnected) return null
    const text = plainText(translated).trim()
    if (!text || text === segment.text) return null
    const marker = attributeMarker(segment.attribute)
    if (element.hasAttribute(marker)) return null
    const original = element.getAttribute(segment.attribute) ?? ''
    element.setAttribute(marker, original)
    element.setAttribute(segment.attribute, text)
    this.records.push({ kind: 'attribute', element, attribute: segment.attribute, original, translated: text })
    return text
  }

  private applyLabel(segment: Extract<Segment, { kind: 'label' }>, translated: string): string | null {
    const element = segment.element
    if (!element.isConnected) return null
    const text = plainText(translated).trim()
    if (!text || text === segment.text) return null
    const original = element.textContent ?? ''
    let addedValue = false
    // An option without a value submits its text; pin the value before the text changes.
    if (element.tagName === 'OPTION' && !element.hasAttribute('value')) {
      element.setAttribute('value', original.replace(/\s+/gu, ' ').trim())
      addedValue = true
    }
    element.textContent = text
    element.setAttribute(LABEL_MARKER, '1')
    this.records.push({ kind: 'label', element, original, translated: text, addedValue })
    return text
  }

  private applyText(segment: Extract<Segment, { kind: 'text' }>, translated: string, options: RenderOptions): string | null {
    const node = segment.node
    if (!node.isConnected || !translated.trim()) return null
    if (options.displayMode === 'bilingual' && segment.text.trim().length >= 40) {
      const inline = document.createElement(TRANSLATION_TAG.toLowerCase())
      inline.className = `${TRANSLATION_CLASS} tfv-inline`
      labelLanguage(inline, options.targetLanguage)
      inline.textContent = translated
      hideDuplicateFromScreenReaders(inline)
      node.after(inline)
      this.records.push({ kind: 'text', node, originalData: node.data, translated, appended: inline })
      return translated
    }
    const originalData = node.data
    node.data = translated
    this.records.push({ kind: 'text', node, originalData, translated, appended: null })
    return translated
  }

  // The page re-rendered a translated unit. Drop our bookkeeping and output for it so the caller
  // can collect it again, unless what is there is our translation (read back by the page) or the
  // page's edit of it, which must not be sent to the engine as source text.
  reset(target: Element): boolean {
    if (target.getAttribute(UNIT_ATTRIBUTE) === 'kept') return false
    const unitRecord = this.records.find((entry): entry is ElementRecord => entry.kind === 'element' && entry.element === target)
    if (unitRecord && unitRecord.appended === null && !unitRecord.written.some((node) => target.contains(node)) && sameText(target.textContent ?? '', unitRecord.translatedText)) return false
    if (unitRecord && unitRecord.appended === null) {
      const edit = pageEdit(unitRecord)
      if (edit !== 'none') {
        if (edit === 'translation') unitRecord.unrestorable = true
        return false
      }
    }
    let dropped = false
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!
      const owner = record.kind === 'text' ? record.node.parentElement : record.element
      if (owner !== target) continue
      if (record.kind === 'attribute') restoreAttribute(record)
      else if (record.kind === 'label') restoreLabel(record)
      else {
        if (record.appended?.isConnected) record.appended.remove()
        if (record.kind === 'element') {
          clearIds(record.element)
          restoreLangDir(record)
        }
      }
      this.records.splice(index, 1)
      dropped = true
    }
    const hadMarker = target.hasAttribute(UNIT_ATTRIBUTE)
    target.removeAttribute(UNIT_ATTRIBUTE)
    return dropped || hadMarker
  }

  forgetAttribute(element: Element, attribute: string): void {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!
      if (record.kind === 'attribute' && record.element === element && record.attribute === attribute) this.records.splice(index, 1)
    }
    element.removeAttribute(attributeMarker(attribute))
  }

  // Returns how many units went back to their originals and how many the page edited in a way that
  // cannot be carried back (those stay as the page left them).
  restoreAll(): { restored: number; kept: number } {
    let restored = 0
    let kept = 0
    for (const record of this.records.reverse()) {
      if (record.kind === 'attribute') {
        restoreAttribute(record)
        restored += 1
        continue
      }
      if (record.kind === 'label') {
        restoreLabel(record)
        restored += 1
        continue
      }
      if (record.kind === 'text') {
        if (record.appended) record.appended.remove()
        // Only text still ours goes back; a page that rewrote the node owns it now.
        else if (record.node.data === record.translated) record.node.data = record.originalData
        restored += 1
        continue
      }
      const element = record.element
      if (record.appended === null && (record.unrestorable || pageEdit(record) === 'translation')) {
        kept += 1
        clearIds(element)
        element.setAttribute(UNIT_ATTRIBUTE, 'kept')
        continue
      }
      if (record.appended) record.appended.remove()
      else {
        const reusedSet = new Set(record.reused.map((entry) => entry.element))
        for (const { element: reused, children, writtenText } of record.reused) {
          if (ownText(reused, reusedSet) !== writtenText) continue
          reused.replaceChildren(...children)
        }
        element.replaceChildren(...record.originalChildren)
      }
      clearIds(element)
      element.removeAttribute(UNIT_ATTRIBUTE)
      restoreLangDir(record)
      restored += 1
    }
    this.records.length = 0
    // Markers on elements the page cloned after translation have no record; sweep them.
    for (const stray of document.querySelectorAll(MARKER_SELECTOR)) {
      for (const attribute of Array.from(stray.attributes)) {
        if (!attribute.name.startsWith('data-tfv-was-')) continue
        stray.setAttribute(attribute.name.slice('data-tfv-was-'.length), attribute.value)
        stray.removeAttribute(attribute.name)
      }
      stray.removeAttribute(LABEL_MARKER)
    }
    for (const unit of document.querySelectorAll(`[${UNIT_ATTRIBUTE}]:not([${UNIT_ATTRIBUTE}="kept"])`)) unit.removeAttribute(UNIT_ATTRIBUTE)
    return { restored, kept }
  }
}

function restoreLangDir(record: ElementRecord): void {
  if (record.appended) return
  if (record.previousLang === null) record.element.removeAttribute('lang')
  else record.element.setAttribute('lang', record.previousLang)
  if (record.previousDir === null) record.element.removeAttribute('dir')
  else record.element.setAttribute('dir', record.previousDir)
}

function restoreAttribute(record: AttributeRecord): void {
  if (record.element.getAttribute(record.attribute) === record.translated) {
    if (record.original) record.element.setAttribute(record.attribute, record.original)
    else record.element.removeAttribute(record.attribute)
  }
  record.element.removeAttribute(attributeMarker(record.attribute))
}

function restoreLabel(record: LabelRecord): void {
  if ((record.element.textContent ?? '') === record.translated) record.element.textContent = record.original
  record.element.removeAttribute(LABEL_MARKER)
  if (record.addedValue) record.element.removeAttribute('value')
}
