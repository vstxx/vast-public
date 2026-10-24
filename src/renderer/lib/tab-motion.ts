import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useBrowserStore } from '../store/browser-store'

// FLIP motion for tab strips (horizontal, vertical sidebar, Purist). Right
// before the store changes which tabs show or their order, where each tab is
// on screen is recorded; after React renders, each tab slides from there to
// its new place. Tabs only ever translate (widths change through CSS), so
// contents never stretch, and nothing is measured unless something moved.

const knownTabs = new Set<string>()
const elements = new Map<string, HTMLElement>()
const MOTION_ID = 'vast-tab-motion'
const reducedMotion = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)')
let positions: Map<string, { left: number; top: number }> | null = null
let unsubscribe: (() => void) | undefined

type StoreState = ReturnType<typeof useBrowserStore.getState>

// What decides where tabs sit: their workspace, order, pinning and grouping.
function stripSignature(state: StoreState): string {
  let signature = `${state.activeWorkspaceId}#`
  for (const tab of state.tabs) signature += `${tab.id}:${tab.workspaceId}:${tab.pinned ? 1 : 0}:${tab.groupId ?? ''}|`
  return signature
}

function capture(): void {
  const next = new Map<string, { left: number; top: number }>()
  for (const [id, element] of elements) {
    if (!element.isConnected) continue
    const rect = element.getBoundingClientRect()
    next.set(id, { left: rect.left, top: rect.top })
  }
  positions = next
  // Every strip has rendered the change by the next frame.
  window.requestAnimationFrame(() => { positions = null })
}

function watchStore(): void {
  if (unsubscribe) return
  unsubscribe = useBrowserStore.subscribe((state, previous) => {
    if (elements.size === 0) return
    if (state.tabs === previous.tabs && state.tabGroups === previous.tabGroups && state.activeWorkspaceId === previous.activeWorkspaceId) return
    if (state.tabGroups !== previous.tabGroups || stripSignature(state) !== stripSignature(previous)) capture()
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
    if (!positions || reducedMotion?.matches || element.closest('.no-motion')) return

    const first = positions.get(tabId)
    if (!first) {
      if (known) return
      playMotion(
        element,
        [
          { opacity: 0.4, transform: 'translate3d(-8px, -2px, 0) scale(0.97)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }
        ],
        { duration: 145, easing: 'cubic-bezier(0.2, 0.82, 0.24, 1)' }
      )
      return
    }

    runningMotion(element)?.cancel()
    const last = element.getBoundingClientRect()
    const deltaX = first.left - last.left
    const deltaY = first.top - last.top
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return
    playMotion(
      element,
      [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 170, easing: 'cubic-bezier(0.2, 0.82, 0.24, 1)' }
    )
  }, [tabId, layoutKey])

  return ref
}
