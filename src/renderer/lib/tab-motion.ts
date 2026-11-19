import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useBrowserStore } from '../store/browser-store'
import { currentMotionLevel, repositionDuration } from './motion'

// FLIP motion for tab strips (horizontal, vertical sidebar, Purist). Right
// before the store changes which tabs show or their order, where each tab is
// on screen is recorded; after React renders, each tab slides from there to
// its new place. Tabs only ever translate (widths change through CSS), so
// contents never stretch, and nothing is measured unless something moved.
// Tabs outside the window are left alone, so long strips stay cheap.

const knownTabs = new Set<string>()
const elements = new Map<string, HTMLElement>()
const MOTION_ID = 'vast-tab-motion'
const EASE_MOVE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const EASE_ENTER = 'cubic-bezier(0.16, 1, 0.3, 1)'
let positions: Map<string, { left: number; top: number }> | null = null
let unsubscribe: (() => void) | undefined

type StoreState = ReturnType<typeof useBrowserStore.getState>

// What decides where tabs sit: their workspace, order, pinning and grouping.
function stripSignature(state: StoreState): string {
  let signature = `${state.activeWorkspaceId}#`
  for (const tab of state.tabs) signature += `${tab.id}:${tab.workspaceId}:${tab.pinned ? 1 : 0}:${tab.groupId ?? ''}|`
  return signature
}

function onScreen(rect: { left: number; top: number }, element: HTMLElement): boolean {
  return rect.top < window.innerHeight && rect.top + element.offsetHeight > 0 && rect.left < window.innerWidth && rect.left + element.offsetWidth > 0
}

// The visible part of the strip around an element: a tab scrolled partly out
// of view must not paint outside its scroller while it withdraws.
function visibleClip(element: HTMLElement, rect: DOMRect): string | null {
  let top = 0
  let left = 0
  let right = window.innerWidth
  let bottom = window.innerHeight
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const box = parent.getBoundingClientRect()
    top = Math.max(top, box.top)
    left = Math.max(left, box.left)
    right = Math.min(right, box.right)
    bottom = Math.min(bottom, box.bottom)
  }
  if (right <= rect.left || left >= rect.right || bottom <= rect.top || top >= rect.bottom) return null
  return `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`
}

// A closed tab withdraws as an inert snapshot while its neighbours close the
// gap; the real tab (and its state) is already gone.
function withdraw(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  const clip = visibleClip(element, rect)
  if (!clip) return
  const ghost = element.cloneNode(true) as HTMLElement
  ghost.removeAttribute('data-tab-motion-id')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  Object.assign(ghost.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    margin: '0', pointerEvents: 'none', zIndex: '35', clipPath: clip, contentVisibility: 'visible'
  })
  document.body.append(ghost)
  const duration = currentMotionLevel() === 'enhanced' ? 140 : 110
  const animation = ghost.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }],
    { duration, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
  )
  const remove = (): void => ghost.remove()
  animation.onfinish = remove
  animation.oncancel = remove
  window.setTimeout(remove, duration + 250)
}

function capture(state: StoreState, previous: StoreState): void {
  const next = new Map<string, { left: number; top: number }>()
  for (const [id, element] of elements) {
    if (!element.isConnected) continue
    const rect = element.getBoundingClientRect()
    next.set(id, { left: rect.left, top: rect.top })
  }
  positions = next
  if (state.tabs.length < previous.tabs.length) {
    const remaining = new Set(state.tabs.map((tab) => tab.id))
    for (const tab of previous.tabs) {
      const element = elements.get(tab.id)
      if (!remaining.has(tab.id) && element?.isConnected && !element.closest('.no-motion')) withdraw(element)
    }
  }
  // Every strip has rendered the change by the next frame.
  window.requestAnimationFrame(() => { positions = null })
}

function watchStore(): void {
  if (unsubscribe) return
  unsubscribe = useBrowserStore.subscribe((state, previous) => {
    if (elements.size === 0 || currentMotionLevel() === 'off') return
    if (state.tabs === previous.tabs && state.tabGroups === previous.tabGroups && state.activeWorkspaceId === previous.activeWorkspaceId) return
    if (state.tabGroups !== previous.tabGroups || stripSignature(state) !== stripSignature(previous)) capture(state, previous)
  })
}

function runningMotion(element: HTMLElement): Animation | undefined {
  return element.getAnimations().find((animation) => animation.id === MOTION_ID)
}

function playMotion(element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): void {
  const animation = element.animate(frames, options)
  animation.id = MOTION_ID
}

/**
 * Enter and reorder motion for a tab. `layoutKey` changes when the strip's
 * tabs or their order change, so title, loading or activation updates never
 * measure anything.
 */
export function useTabMotion<T extends HTMLElement = HTMLButtonElement>(tabId: string, layoutKey: string): RefObject<T | null> {
  const ref = useRef<T | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    watchStore()
    elements.set(tabId, element)
    return () => {
      if (elements.get(tabId) === element) elements.delete(tabId)
    }
  }, [tabId])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const known = knownTabs.has(tabId)
    knownTabs.add(tabId)
    const duration = repositionDuration()
    if (!positions || !duration || element.closest('.no-motion')) return

    const first = positions.get(tabId)
    if (!first) {
      if (known) return
      const last = element.getBoundingClientRect()
      if (!onScreen(last, element)) return
      // A new tab settles into its slot: opacity and a short slide, no scaling.
      const vertical = Boolean(element.closest('[data-tab-sidebar]'))
      playMotion(
        element,
        [
          { opacity: 0, transform: vertical ? 'translate3d(0, -4px, 0)' : 'translate3d(-8px, 0, 0)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration, easing: EASE_ENTER }
      )
      return
    }

    runningMotion(element)?.cancel()
    const last = element.getBoundingClientRect()
    const deltaX = first.left - last.left
    const deltaY = first.top - last.top
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return
    if (!onScreen(first, element) && !onScreen(last, element)) return
    playMotion(
      element,
      [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }, { transform: 'none' }],
      { duration, easing: EASE_MOVE }
    )
  }, [tabId, layoutKey])

  return ref
}
