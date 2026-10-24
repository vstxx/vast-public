import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

interface VirtualRowsProps<T> {
  items: readonly T[]
  /** Stable identity; must not change between renders for the same row. */
  getKey: (item: T) => string
  /** Height (including bottom spacing) used until a row has been measured. */
  estimateHeight: (item: T) => number
  renderRow: (item: T) => ReactNode
  /** Spacing below each row, part of its measured height. */
  rowGap?: (item: T) => number
  overscanPx?: number
  className?: string
}

function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

function firstIndexEndingAfter(offsets: Float64Array, value: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid + 1] > value) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * Renders only the rows near the visible part of the nearest scrolling
 * ancestor. Large lists (imported bookmarks, history) otherwise mount tens of
 * thousands of nodes and re-render all of them on every update.
 */
export function VirtualRows<T>({ items, getKey, estimateHeight, renderRow, rowGap, overscanPx = 800, className }: VirtualRowsProps<T>): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const heights = useRef(new Map<string, number>())
  const [measureVersion, setMeasureVersion] = useState(0)
  const [view, setView] = useState({ top: 0, bottom: 1_200 })

  const offsets = useMemo(() => {
    const next = new Float64Array(items.length + 1)
    for (let index = 0; index < items.length; index++) {
      next[index + 1] = next[index] + (heights.current.get(getKey(items[index])) ?? estimateHeight(items[index]))
    }
    return next
    // measureVersion invalidates the cached heights.
  }, [items, getKey, estimateHeight, measureVersion])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const scroller = scrollParentOf(root)
    if (!scroller) return undefined
    let frame = 0
    const update = (): void => {
      frame = 0
      const top = scroller.getBoundingClientRect().top - root.getBoundingClientRect().top
      setView((current) => (current.top === top && current.bottom === top + scroller.clientHeight ? current : { top, bottom: top + scroller.clientHeight }))
    }
    const schedule = (): void => { if (!frame) frame = window.requestAnimationFrame(update) }
    update()
    scroller.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    return () => {
      window.cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [])

  const start = items.length ? firstIndexEndingAfter(offsets, view.top - overscanPx) : 0
  let end = start
  while (end < items.length && offsets[end] < view.bottom + overscanPx) end++

  // Record real heights of the rendered rows; estimates only fill the gaps.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let changed = false
    for (const row of root.querySelectorAll<HTMLElement>('[data-virtual-key]')) {
      const key = row.dataset.virtualKey!
      const height = row.offsetHeight
      if (height > 0 && heights.current.get(key) !== height) {
        heights.current.set(key, height)
        changed = true
      }
    }
    if (changed) setMeasureVersion((version) => version + 1)
  })

  const rows: ReactNode[] = []
  for (let index = start; index < end; index++) {
    const item = items[index]
    const key = getKey(item)
    rows.push(
      <div key={key} data-virtual-key={key} style={rowGap ? { paddingBottom: rowGap(item) } : undefined}>
        {renderRow(item)}
      </div>
    )
  }

  return (
    <div ref={rootRef} className={className} style={{ position: 'relative', height: offsets[items.length] }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, transform: `translateY(${offsets[start]}px)` }}>
        {rows}
      </div>
    </div>
  )
}
