// Visible-first batching. Adapted from Glossa src/content/scheduler.ts (MIT, SysAdminDoc).
// One IntersectionObserver moves segments between "visible" and "waiting"; batches take visible
// segments first and are bounded by both count and characters. No layout is read here.

import { segmentElement, segmentLength, type Segment } from './segmenter.ts'

export interface Scheduler {
  readonly size: number
  next(maxItems: number, maxChars: number): Segment[]
  stop(): void
}

export function createScheduler(segments: Segment[]): Scheduler {
  const waiting = new Set<Segment>(segments)
  const visible = new Set<Segment>()
  const byElement = new Map<Element, Segment[]>()
  for (const segment of segments) {
    const element = segmentElement(segment)
    if (!element) continue
    const list = byElement.get(element)
    if (list) list.push(segment)
    else byElement.set(element, [segment])
  }
  let observer: IntersectionObserver | null = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        for (const segment of byElement.get(entry.target) ?? []) {
          if (!waiting.has(segment) && !visible.has(segment)) continue
          if (entry.isIntersecting) {
            waiting.delete(segment)
            visible.add(segment)
          } else if (visible.delete(segment)) waiting.add(segment)
        }
      }
    }, { rootMargin: '25% 0px' })
    : null
  for (const element of byElement.keys()) observer?.observe(element)

  function take(from: Set<Segment>, batch: Segment[], budget: { chars: number }, maxItems: number, maxChars: number): void {
    for (const segment of from) {
      if (batch.length >= maxItems) return
      const length = segmentLength(segment)
      if (batch.length > 0 && budget.chars + length > maxChars) return
      batch.push(segment)
      budget.chars += length
      from.delete(segment)
      const element = segmentElement(segment)
      if (element && !(byElement.get(element) ?? []).some((other) => waiting.has(other) || visible.has(other))) observer?.unobserve(element)
    }
  }

  return {
    get size() {
      return waiting.size + visible.size
    },
    next(maxItems, maxChars) {
      const batch: Segment[] = []
      const budget = { chars: 0 }
      take(visible, batch, budget, maxItems, maxChars)
      take(waiting, batch, budget, maxItems, maxChars)
      return batch
    },
    stop() {
      observer?.disconnect()
      observer = null
      waiting.clear()
      visible.clear()
    }
  }
}

// Resolves when the tab is visible: a background tab is not worth the engine's time.
export function whenVisible(): Promise<void> {
  if (document.visibilityState !== 'hidden') return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (document.visibilityState === 'hidden') return
      document.removeEventListener('visibilitychange', onChange)
      resolve()
    }
    document.addEventListener('visibilitychange', onChange)
  })
}

// The intersection observer reports asynchronously; give it one frame before the first batch so
// the visible blocks really go first. A document that renders no frames (occluded) does not wait.
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 50)
    requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
