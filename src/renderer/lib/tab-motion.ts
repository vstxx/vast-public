import { useLayoutEffect, useRef, type RefObject } from 'react'

interface LayoutBox {
  x: number
  y: number
  width: number
  height: number
}

const previousLayouts = new Map<string, LayoutBox>()
const knownTabs = new Set<string>()
const MOTION_ID = 'vast-tab-motion'

function stableLayoutBox(element: HTMLElement): LayoutBox {
  let x = 0
  let y = 0
  let node: HTMLElement | null = element
  while (node) {
    x += node.offsetLeft
    y += node.offsetTop
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null
  }
  return { x, y, width: element.offsetWidth, height: element.offsetHeight }
}

function sameLayout(left: LayoutBox, right: LayoutBox): boolean {
  return Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5
}

function runningMotion(element: HTMLElement): Animation | undefined {
  return element.getAnimations().find((animation) => animation.id === MOTION_ID)
}

function playMotion(element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): void {
  const animation = element.animate(frames, options)
  animation.id = MOTION_ID
}

export function useTabMotion<T extends HTMLElement = HTMLButtonElement>(tabId: string): RefObject<T | null> {
  const ref = useRef<T | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const currentLayout = stableLayoutBox(element)
    const previousLayout = previousLayouts.get(tabId)
    const alreadyKnown = knownTabs.has(tabId)
    previousLayouts.set(tabId, currentLayout)
    knownTabs.add(tabId)

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    if (!alreadyKnown) {
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

    if (!previousLayout || sameLayout(previousLayout, currentLayout)) return

    const activeMotion = runningMotion(element)
    const visualBeforeRetarget = activeMotion ? element.getBoundingClientRect() : undefined
    activeMotion?.cancel()
    const finalRect = element.getBoundingClientRect()
    const deltaX = visualBeforeRetarget ? visualBeforeRetarget.left - finalRect.left : previousLayout.x - currentLayout.x
    const deltaY = visualBeforeRetarget ? visualBeforeRetarget.top - finalRect.top : previousLayout.y - currentLayout.y
    const scaleX = visualBeforeRetarget && finalRect.width > 0
      ? visualBeforeRetarget.width / finalRect.width
      : currentLayout.width > 0
        ? previousLayout.width / currentLayout.width
        : 1

    playMotion(
      element,
      [
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scaleX(${scaleX})`, transformOrigin: 'left center' },
        { transform: 'translate3d(0, 0, 0) scaleX(1)', transformOrigin: 'left center' }
      ],
      { duration: 160, easing: 'cubic-bezier(0.2, 0.82, 0.24, 1)' }
    )
  })

  return ref
}
