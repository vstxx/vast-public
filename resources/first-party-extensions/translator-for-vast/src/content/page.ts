// Whole-page translation for one document: collect units, translate visible ones first, follow the
// page's later changes while translated, and restore. The flow follows Glossa src/content/content.ts
// (MIT, SysAdminDoc). Everything here dies with the document, so a result can never be applied to a
// document other than the one that asked for it.

import { normalizeLanguageTag } from '../shared/languages.ts'
import { SCOPE, errorMessage, type PageState, type Reply } from '../shared/protocol.ts'
import type { DisplayMode } from '../shared/settings.ts'
import { Renderer } from './renderer.ts'
import { createScheduler, nextFrame, whenVisible } from './scheduler.ts'
import {
  attributeMarker,
  attributeSegment,
  collectFromNodes,
  collectSegments,
  prepareSegment,
  READABLE_ATTRIBUTES,
  segmentFragment,
  TRANSLATION_TAG,
  UNIT_ATTRIBUTE,
  type Segment,
  type SegmentOptions
} from './segmenter.ts'

const BATCH_MAX_ITEMS = 24
const BATCH_MAX_CHARS = 6_000
const OBSERVER_DEBOUNCE_MS = 250
const OBSERVER_WINDOW_MS = 5_000
const MAX_OBSERVER_PASSES = 8
const STATE_REPORT_MS = 200
const WATCHED_ATTRIBUTES = ['hidden', 'open', 'translate', 'lang', 'aria-hidden', 'class', 'style', ...READABLE_ATTRIBUTES]
const DIRECT_ATTRIBUTES = new Set(['hidden', 'open', 'translate', 'lang', 'aria-hidden'])
const OUTPUT_MEMORY = 5_000

export const UI_HOST_TAG = 'tfv-ui'

export async function send<T>(message: Record<string, unknown>): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ scope: SCOPE, ...message }) as Reply<T> | undefined
  if (!reply) throw new Error('The extension did not answer')
  if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code })
  return reply.value
}

// Text this extension wrote. The page may read it back and re-render it; it is never source text.
class OutputMemory {
  private readonly seen = new Set<string>()
  remember(text: string): void {
    const key = text.replace(/\s+/g, ' ').trim()
    if (key.length < 12) return
    this.seen.delete(key)
    this.seen.add(key)
    if (this.seen.size > OUTPUT_MEMORY) this.seen.delete(this.seen.values().next().value!)
  }
  has(text: string): boolean {
    return this.seen.has(text.replace(/\s+/g, ' ').trim())
  }
  clear(): void {
    this.seen.clear()
  }
}

function isOurs(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if (current.nodeType !== Node.ELEMENT_NODE) continue
    const tag = (current as Element).tagName
    if (tag === TRANSLATION_TAG || tag === UI_HOST_TAG.toUpperCase()) return true
  }
  return false
}

export class PageTranslator {
  readonly state: PageState = { status: 'idle', source: null, target: null, done: 0, total: 0, error: null, kept: 0 }
  private readonly renderer = new Renderer()
  private readonly output = new OutputMemory()
  private readonly routes = new Map<string, boolean>()
  private readonly deferred = new Set<Element>()
  private readonly pending = new Set<Node>()
  private readonly stale = new Set<Element>()
  private readonly attributeChanges = new Map<Element, Set<string>>()
  private observer: MutationObserver | null = null
  private observerTimer: number | null = null
  private readonly observerPasses: number[] = []
  private reportTimer: number | null = null
  private generation = 0
  private displayMode: DisplayMode = 'replace'
  private pageLanguage: string | null = null

  constructor() {
    // Leaving the document cancels whatever it still had queued in the engine.
    addEventListener('pagehide', () => {
      if (this.state.status === 'translating') void send({ type: 'content:cancel' }).catch(() => undefined)
    })
  }

  private options(): SegmentOptions {
    return { skipFormFields: true, deferred: this.deferred }
  }

  private report(immediate = false): void {
    const flush = () => {
      this.reportTimer = null
      void chrome.runtime.sendMessage({ scope: SCOPE, type: 'content:state', state: { ...this.state } }).catch(() => undefined)
    }
    if (immediate) {
      if (this.reportTimer !== null) clearTimeout(this.reportTimer)
      flush()
      return
    }
    this.reportTimer ??= window.setTimeout(flush, STATE_REPORT_MS)
  }

  async translate(source: string, target: string, displayMode: DisplayMode): Promise<PageState> {
    if (this.state.status === 'translating') return { ...this.state }
    // A different language or display asked for while translated: start from the original.
    if (this.state.status === 'translated') {
      if (this.state.source === source && this.state.target === target && this.displayMode === displayMode) return { ...this.state }
      this.restore()
    }
    const generation = ++this.generation
    Object.assign(this.state, { status: 'translating', source, target, done: 0, total: 0, error: null, kept: 0 })
    this.displayMode = displayMode
    this.pageLanguage = normalizeLanguageTag(document.documentElement.getAttribute('lang'))
    this.routes.clear()
    this.report(true)
    try {
      const segments = collectSegments(document.body, this.options())
      const title = document.querySelector('head > title')
      if (title) segments.unshift(...collectFromNodes([title], this.options()))
      this.state.total = segments.length
      await this.translateByLanguage(segments, source, target, generation)
      if (generation !== this.generation) return { ...this.state }
      this.state.status = this.state.error && this.state.done === 0 ? 'error' : 'translated'
      if (this.state.status === 'translated') this.startObserver()
    } catch (error) {
      if (generation === this.generation) {
        this.state.status = 'error'
        this.state.error = errorMessage(error)
      }
    } finally {
      if (generation === this.generation) this.report(true)
    }
    return { ...this.state }
  }

  // A unit that declares another language goes through that language's model, and only when the
  // model is already here: one quoted paragraph is no reason to download a language.
  private async translateByLanguage(segments: Segment[], source: string, target: string, generation: number): Promise<void> {
    const groups = new Map<string, Segment[]>()
    for (const segment of segments) {
      const declared = normalizeLanguageTag(segment.lang)
      const language = declared && declared !== this.pageLanguage ? declared : source
      if (language === target) {
        this.state.total -= 1
        continue
      }
      const group = groups.get(language)
      if (group) group.push(segment)
      else groups.set(language, [segment])
    }
    for (const language of [source, ...[...groups.keys()].filter((entry) => entry !== source)]) {
      const group = groups.get(language)
      if (!group) continue
      if (language !== source && !await this.routeInstalled(language, target)) {
        this.state.total -= group.length
        continue
      }
      if (generation !== this.generation) return
      await this.translateSegments(group, language, target, generation)
      if (this.state.error) return
    }
  }

  private async routeInstalled(source: string, target: string): Promise<boolean> {
    const key = `${source}>${target}`
    const known = this.routes.get(key)
    if (known !== undefined) return known
    let installed = false
    try {
      installed = (await send<{ installed: boolean }>({ type: 'content:route', source, target })).installed
    } catch {
      installed = false
    }
    this.routes.set(key, installed)
    return installed
  }

  private async translateSegments(segments: Segment[], source: string, target: string, generation: number): Promise<void> {
    const fresh = segments.filter((segment) => !this.output.has(segment.text))
    this.state.total -= segments.length - fresh.length
    this.withObserverPaused(fresh, () => { for (const segment of fresh) this.renderer.markPending(segment) })
    const scheduler = createScheduler(fresh)
    const abandon = () => {
      const rest = scheduler.next(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      this.withObserverPaused(rest, () => { for (const segment of rest) this.renderer.unmark(segment) })
      scheduler.stop()
    }
    try {
      await nextFrame()
      for (;;) {
        await whenVisible()
        if (generation !== this.generation) return abandon()
        const next = scheduler.next(BATCH_MAX_ITEMS, BATCH_MAX_CHARS)
        if (next.length === 0) break
        // Numbering and serialising happen per batch, so the cost follows what is being sent.
        const batch: Segment[] = []
        this.withObserverPaused(next, () => {
          for (const segment of next) {
            if (prepareSegment(segment)) batch.push(segment)
            else this.renderer.unmark(segment)
          }
        })
        this.state.total -= next.length - batch.length
        if (batch.length === 0) continue
        let fragments: string[]
        try {
          fragments = (await send<{ fragments: string[] }>({ type: 'content:translate', source, target, fragments: batch.map(segmentFragment), priority: 'page' })).fragments
        } catch (error) {
          this.withObserverPaused(batch, () => { for (const segment of batch) this.renderer.unmark(segment) })
          if (generation === this.generation) {
            this.state.error = errorMessage(error)
            this.report(true)
          }
          return abandon()
        }
        if (generation !== this.generation) {
          this.withObserverPaused(batch, () => { for (const segment of batch) this.renderer.unmark(segment) })
          return abandon()
        }
        let written = 0
        this.withObserverPaused(batch, () => {
          batch.forEach((segment, slot) => {
            // Reset or restored while in flight: the old answer must not overwrite what replaced it.
            if (segment.kind === 'element' && segment.element.getAttribute(UNIT_ATTRIBUTE) !== 'pending') return
            const applied = this.renderer.apply(segment, fragments[slot] ?? '', { displayMode: this.displayMode, targetLanguage: target })
            if (applied) {
              this.output.remember(applied)
              written += 1
            }
          })
        })
        this.state.done += written
        this.report()
        // Yield between batches so input and rendering always get a turn.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      scheduler.stop()
    }
  }

  restore(): PageState {
    this.generation += 1
    this.stopObserver()
    this.deferred.clear()
    this.output.clear()
    this.routes.clear()
    const scroll = { x: scrollX, y: scrollY }
    const focused = document.activeElement
    const { kept } = this.renderer.restoreAll()
    if (scrollX !== scroll.x || scrollY !== scroll.y) scrollTo(scroll.x, scroll.y)
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
    Object.assign(this.state, { status: 'idle', done: 0, total: 0, error: null, kept })
    if (kept === 0) Object.assign(this.state, { source: null, target: null })
    this.report(true)
    void send({ type: 'content:cancel' }).catch(() => undefined)
    return { ...this.state }
  }

  // ---------- Following the page after translation ----------

  private startObserver(): void {
    this.stopObserver()
    const observer = new MutationObserver((mutations) => {
      let queued = false
      for (const mutation of mutations) if (this.classify(mutation)) queued = true
      if (queued) this.schedule()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES })
    this.observer = observer
  }

  private stopObserver(): void {
    this.observer?.disconnect()
    this.observer = null
    this.pending.clear()
    this.stale.clear()
    this.attributeChanges.clear()
    this.observerPasses.length = 0
    if (this.observerTimer !== null) clearTimeout(this.observerTimer)
    this.observerTimer = null
  }

  private classify(mutation: MutationRecord): boolean {
    if (isOurs(mutation.target)) return false
    switch (mutation.type) {
      case 'childList':
        if (this.markStale(mutation.target)) return true
        for (const node of mutation.addedNodes) {
          if ((node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) && !isOurs(node)) this.pending.add(node)
        }
        return this.pending.size > 0
      case 'characterData':
        if (this.markStale(mutation.target)) return true
        this.pending.add(mutation.target)
        return true
      case 'attributes': {
        const element = mutation.target as Element
        const name = mutation.attributeName ?? ''
        if (READABLE_ATTRIBUTES.includes(name)) {
          if (element.hasAttribute(attributeMarker(name))) this.renderer.forgetAttribute(element, name)
          const names = this.attributeChanges.get(element) ?? new Set<string>()
          names.add(name)
          this.attributeChanges.set(element, names)
          return true
        }
        let queued = false
        if (name === 'lang' || name === 'translate') queued = this.markStale(element) || queued
        if (DIRECT_ATTRIBUTES.has(name)) {
          this.pending.add(element)
          queued = true
        }
        return this.recheckDeferred() || queued
      }
      default:
        return false
    }
  }

  private schedule(): void {
    if (this.observerTimer !== null) return
    const now = Date.now()
    while (this.observerPasses.length && now - this.observerPasses[0]! >= OBSERVER_WINDOW_MS) this.observerPasses.shift()
    const backoff = this.observerPasses.length >= MAX_OBSERVER_PASSES
      ? Math.max(0, this.observerPasses[0]! + OBSERVER_WINDOW_MS - now)
      : 0
    this.observerTimer = window.setTimeout(() => {
      this.observerTimer = null
      void this.translateChanged()
    }, Math.max(OBSERVER_DEBOUNCE_MS, backoff))
  }

  private markStale(node: Node): boolean {
    for (let current: Node | null = node; current && current !== document.body; current = current.parentNode) {
      if (current.nodeType === Node.ELEMENT_NODE && (current as Element).hasAttribute(UNIT_ATTRIBUTE)) {
        this.stale.add(current as Element)
        return true
      }
    }
    return false
  }

  // Only elements skipped earlier as hidden are re-examined, so pages that churn classes stay cheap.
  private recheckDeferred(): boolean {
    let queued = false
    for (const element of this.deferred) {
      if (!element.isConnected) {
        this.deferred.delete(element)
        continue
      }
      const probe = element as Element & { checkVisibility?: () => boolean }
      if (!(element as HTMLElement).hidden && (probe.checkVisibility?.() ?? true)) {
        this.deferred.delete(element)
        this.pending.add(element)
        queued = true
      }
    }
    return queued
  }

  // Bounded dirty subtrees only: the topmost of the changed roots are collected, never the page.
  private async translateChanged(): Promise<void> {
    const source = this.state.source
    const target = this.state.target
    if (this.state.status !== 'translated' || !source || !target) return
    const roots = [...this.pending]
    this.pending.clear()
    const stale = [...this.stale]
    this.stale.clear()
    const attributeChanges = [...this.attributeChanges]
    this.attributeChanges.clear()
    this.withObserverPaused(stale, () => {
      for (const element of stale) if (this.renderer.reset(element) && element.isConnected) roots.push(element)
    })
    const candidates = [...new Set(roots)].filter((root) => root.isConnected && !(root.nodeType === Node.TEXT_NODE && root.parentElement?.hasAttribute(UNIT_ATTRIBUTE)))
    // Checking every candidate against every other candidate made a large SPA insertion quadratic.
    // A root is redundant exactly when one of its ancestors is already queued.
    const candidateSet = new Set(candidates)
    const live = candidates.filter((root) => {
      for (let ancestor = root.parentNode; ancestor; ancestor = ancestor.parentNode) {
        if (candidateSet.has(ancestor)) return false
      }
      return true
    })
    const segments = collectFromNodes(live, this.options())
    for (const [element, names] of attributeChanges) {
      if (!element.isConnected) continue
      for (const name of names) {
        const segment = attributeSegment(element, name, this.options())
        if (segment) segments.push(segment)
      }
    }
    if (segments.length === 0) return
    this.observerPasses.push(Date.now())
    this.state.total += segments.length
    this.state.status = 'translating'
    const generation = this.generation
    await this.translateByLanguage(segments, source, target, generation)
    if (generation === this.generation) {
      this.state.status = 'translated'
      this.report()
      if (this.pending.size || this.stale.size || this.attributeChanges.size) this.schedule()
    }
  }

  // Our own writes must not come back as mutations. Records the page made in the same turn are
  // replayed rather than dropped, so its content is never lost.
  private withObserverPaused(written: Iterable<Segment | Node>, write: () => void): void {
    const ours = new Set<Node>()
    for (const segment of written) {
      if (segment instanceof Node) ours.add(segment)
      else if (segment.kind === 'text') {
        ours.add(segment.node)
        if (segment.node.parentNode) ours.add(segment.node.parentNode)
      } else ours.add(segment.element)
    }
    try {
      write()
    } finally {
      const records = this.observer?.takeRecords() ?? []
      let queued = false
      for (const record of records) {
        if (ours.has(record.target)) continue
        if (this.classify(record)) queued = true
      }
      if (queued) this.schedule()
    }
  }
}
