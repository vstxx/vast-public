import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefCallback } from 'react'
import type { MotionPreference } from '../../shared/types'

// Vast's motion system for floating surfaces: one Web Animation per element at
// a time, transform and opacity only, no layer hints at rest. Interrupting a
// surface (close while opening, reopen while closing) starts the new motion
// from where the element visibly is, so rapid input always ends in the latest
// requested state. Logical state never waits for motion: callers flip their
// state immediately and only the DOM lingers, inert, while it exits.

export type MotionLevel = 'off' | 'standard' | 'enhanced'
/** Which way a surface travels in from: below its anchor, above it, or from an edge. */
export type MotionSide = 'below' | 'above' | 'right' | 'left'
export type MotionKind = 'menu' | 'popover' | 'context' | 'suggest' | 'find' | 'dialog' | 'backdrop' | 'panel' | 'docked' | 'toast' | 'fade'

export const MOTION_EXITING_ATTRIBUTE = 'data-motion-exiting'

const EASE_ENTER = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)'

interface MotionSpec {
  /** Entrance duration (ms); exits run at `exit` × this. */
  duration: number
  /** Travel distance (px) along the side the surface comes from. */
  distance: number
  /** Starting scale; 1 means opacity and translation only. */
  scale: number
}

// Standard is restrained; Enhanced adds travel and time for clearer spatial
// continuity, never blur, glow or bigger shadows.
const SPECS: Record<Exclude<MotionKind, 'backdrop'>, Record<Exclude<MotionLevel, 'off'>, MotionSpec>> = {
  menu: { standard: { duration: 150, distance: 4, scale: 0.98 }, enhanced: { duration: 190, distance: 6, scale: 0.97 } },
  // Translation and opacity only: for containers that may host web content.
  popover: { standard: { duration: 150, distance: 4, scale: 1 }, enhanced: { duration: 185, distance: 6, scale: 1 } },
  context: { standard: { duration: 130, distance: 3, scale: 0.98 }, enhanced: { duration: 165, distance: 4, scale: 0.975 } },
  suggest: { standard: { duration: 140, distance: 4, scale: 1 }, enhanced: { duration: 180, distance: 6, scale: 0.995 } },
  find: { standard: { duration: 150, distance: 6, scale: 0.98 }, enhanced: { duration: 190, distance: 8, scale: 0.97 } },
  dialog: { standard: { duration: 220, distance: 8, scale: 0.985 }, enhanced: { duration: 280, distance: 12, scale: 0.98 } },
  panel: { standard: { duration: 210, distance: 12, scale: 1 }, enhanced: { duration: 265, distance: 16, scale: 0.99 } },
  docked: { standard: { duration: 190, distance: 8, scale: 1 }, enhanced: { duration: 240, distance: 12, scale: 1 } },
  toast: { standard: { duration: 200, distance: 12, scale: 1 }, enhanced: { duration: 250, distance: 16, scale: 0.98 } },
  fade: { standard: { duration: 140, distance: 0, scale: 1 }, enhanced: { duration: 180, distance: 0, scale: 1 } }
}

const EXIT_RATIO = 0.7
const DEFAULT_SIDE: Record<MotionKind, MotionSide> = {
  menu: 'below', popover: 'below', context: 'below', suggest: 'below', find: 'below', dialog: 'below', backdrop: 'below',
  panel: 'right', docked: 'right', toast: 'right', fade: 'below'
}

let level: MotionLevel = 'standard'

export function setMotionLevel(next: MotionLevel): void {
  level = next
}

export function currentMotionLevel(): MotionLevel {
  return level
}

/**
 * The single place the user's choice meets runtime constraints: reduced
 * motion or animations turned off mean no motion, and constrained graphics
 * cap Enhanced at Standard. Enhanced is never enabled automatically.
 */
export function resolveMotionLevel(input: { animations: boolean; preference: MotionPreference | undefined; reducedMotion: boolean; constrainedGraphics: boolean }): MotionLevel {
  if (!input.animations || input.reducedMotion) return 'off'
  return input.preference === 'enhanced' && !input.constrainedGraphics ? 'enhanced' : 'standard'
}

// Backdrops are frosted: fading one re-blurs the page behind it
// every frame, which measurably dropped frames when Settings opened. They
// appear and leave with their dialog without animating, but still take part
// in the exit lifecycle (inert, pointer-transparent until removed).
export function motionSpec(kind: MotionKind, at: MotionLevel = level): MotionSpec | null {
  return at === 'off' || kind === 'backdrop' ? null : SPECS[kind][at]
}

/**
 * Focuses a control on the surface's first frame. When the surface is being
 * reopened mid-exit it is still inert during its own layout effect (the
 * presence owner restores it right after), so focus is retried once the
 * commit's layout effects have run, still before paint.
 */
export function focusWhenReady(element: HTMLElement | null | undefined): void {
  if (!element) return
  element.focus()
  if (document.activeElement !== element) queueMicrotask(() => { if (element.isConnected) element.focus() })
}

/** A motion duration for the current level, or 0 when motion is off. */
export function motionDuration(kind: MotionKind): number {
  return motionSpec(kind)?.duration ?? 0
}

function hiddenFrame(kind: MotionKind, spec: MotionSpec, side: MotionSide): Keyframe {
  const distance = spec.distance
  // A surface below its anchor rises from slightly above; one above it drops
  // from slightly below; edge panels come in from their own edge.
  const x = side === 'right' ? distance : side === 'left' ? -distance : 0
  const y = side === 'below' ? -distance : side === 'above' ? distance : 0
  const translate = kind === 'dialog' ? `translate3d(0, ${distance}px, 0)` : `translate3d(${x}px, ${y}px, 0)`
  return { opacity: 0, transform: spec.scale === 1 ? translate : `${translate} scale(${spec.scale})` }
}

const VISIBLE: Keyframe = { opacity: 1, transform: 'none' }
const running = new WeakMap<Element, Animation>()

// Where an element visibly is while a previous motion is still playing, so the
// next motion continues from there instead of jumping.
function takeOver(element: Element): Keyframe | null {
  const previous = running.get(element)
  if (!previous) return null
  running.delete(element)
  if (previous.playState !== 'running' && previous.playState !== 'paused') {
    previous.cancel()
    return null
  }
  const style = getComputedStyle(element)
  const frame: Keyframe = { opacity: Number(style.opacity), transform: style.transform === 'none' ? 'none' : style.transform }
  previous.cancel()
  return frame
}

function sideOf(element: Element, kind: MotionKind, side?: MotionSide): MotionSide {
  const declared = (element as HTMLElement).dataset?.motionSide
  return side ?? (declared === 'above' || declared === 'below' || declared === 'left' || declared === 'right' ? declared : DEFAULT_SIDE[kind])
}

/** Plays an element's entrance (or continues it from an interrupted exit). */
export function playEnter(element: Element, kind: MotionKind, side?: MotionSide): Animation | null {
  const spec = motionSpec(kind)
  const from = takeOver(element)
  // Critical surfaces opt out of entrances; a takeover (reopening mid-exit) still eases back.
  if (!spec || typeof element.animate !== 'function' || (!from && element.hasAttribute('data-motion-immediate'))) return null
  const hidden = hiddenFrame(kind, spec, sideOf(element, kind, side))
  const animation = element.animate([from ?? hidden, VISIBLE], { duration: spec.duration, easing: EASE_ENTER })
  running.set(element, animation)
  const forget = (): void => { if (running.get(element) === animation) running.delete(element) }
  animation.onfinish = forget
  animation.oncancel = forget
  return animation
}

/**
 * Plays an element's exit from wherever it is and calls `done` once it is
 * hidden. Returns a function that abandons the callback (the animation itself
 * is taken over by the next playEnter). Safe when motion is off: `done` runs
 * synchronously.
 */
export function playExit(element: Element, kind: MotionKind, done: () => void, side?: MotionSide): () => void {
  const spec = motionSpec(kind)
  const from = takeOver(element)
  if (!spec || typeof element.animate !== 'function') {
    done()
    return () => undefined
  }
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    window.clearTimeout(fallback)
    done()
  }
  const duration = Math.round(spec.duration * EXIT_RATIO)
  const animation = element.animate([from ?? VISIBLE, hiddenFrame(kind, spec, sideOf(element, kind, side))], { duration, easing: EASE_EXIT, fill: 'forwards' })
  running.set(element, animation)
  animation.onfinish = finish
  // A hidden or throttled window may never tick the animation; never leave a
  // closed surface mounted because of that.
  const fallback = window.setTimeout(finish, duration + 250)
  return () => {
    settled = true
    window.clearTimeout(fallback)
    animation.onfinish = null
  }
}

const REPOSITION_MS: Record<Exclude<MotionLevel, 'off'>, number> = { standard: 180, enhanced: 220 }
const EASE_MOVE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Duration for FLIP repositioning of existing elements at the current level. */
export function repositionDuration(): number {
  return level === 'off' ? 0 : REPOSITION_MS[level]
}

/**
 * FLIP: slides an element that has already moved from where it was (`dx`,
 * `dy` = old minus new on-screen position, measured including any motion
 * still playing). Translation only, so text never stretches.
 */
export function playMove(element: Element, dx: number, dy: number): Animation | null {
  const duration = repositionDuration()
  running.get(element)?.cancel()
  running.delete(element)
  if (!duration || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || typeof element.animate !== 'function') return null
  const animation = element.animate([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'none' }], { duration, easing: EASE_MOVE })
  running.set(element, animation)
  const forget = (): void => { if (running.get(element) === animation) running.delete(element) }
  animation.onfinish = forget
  animation.oncancel = forget
  return animation
}

// A leaving surface is no longer the widget it was: it cannot be focused,
// clicked or found by its role (a menu that is fading out is not "a menu").
function markExiting(element: HTMLElement, exiting: boolean): void {
  if (exiting) {
    if (element.hasAttribute(MOTION_EXITING_ATTRIBUTE)) return
    element.setAttribute(MOTION_EXITING_ATTRIBUTE, element.getAttribute('role') ?? '')
    element.removeAttribute('role')
    element.inert = true
    element.style.pointerEvents = 'none'
  } else if (element.hasAttribute(MOTION_EXITING_ATTRIBUTE)) {
    const role = element.getAttribute(MOTION_EXITING_ATTRIBUTE)
    if (role) element.setAttribute('role', role)
    element.removeAttribute(MOTION_EXITING_ATTRIBUTE)
    element.inert = false
    element.style.pointerEvents = ''
  }
}

export interface Presence {
  /** Render the surface while true; it stays true through the exit. */
  mounted: boolean
  /** True while the surface plays its exit: it is inert and must not react. */
  exiting: boolean
  /** Ref for an animated part of the surface, by motion kind. */
  ref: (kind: MotionKind) => RefCallback<HTMLElement>
}

/**
 * Mount/exit lifecycle for a conditionally rendered surface. `open` is the
 * logical state; the returned `mounted` lags it only by the exit motion.
 */
export function usePresence(open: boolean): Presence {
  // Opening costs no extra render (the owner may be App itself): `mounted`
  // follows `open` directly and only a close with motion keeps it lingering.
  const [lingering, setLingering] = useState(false)
  const previousOpen = useRef(open)
  let lingers = lingering
  if (previousOpen.current && !open && level !== 'off' && !lingering) {
    setLingering(true)
    lingers = true
  } else if (open && lingering) {
    setLingering(false)
    lingers = false
  }
  previousOpen.current = open
  const mounted = open || lingers
  const exiting = !open && lingers
  const targets = useRef(new Map<MotionKind, HTMLElement>())
  const callbacks = useRef(new Map<MotionKind, RefCallback<HTMLElement>>())
  // Set once this open cycle's entrance has started; parts that mount later
  // (a lazily loaded surface, a remounted menu) then enter on attach.
  const entered = useRef(false)

  const ref = useCallback((kind: MotionKind): RefCallback<HTMLElement> => {
    let callback = callbacks.current.get(kind)
    if (!callback) {
      callback = (element) => {
        if (!element) {
          targets.current.delete(kind)
          return
        }
        targets.current.set(kind, element)
        if (entered.current) playEnter(element, kind)
      }
      callbacks.current.set(kind, callback)
    }
    return callback
  }, [])

  // Runs after the surface's own layout effects (it is declared after them or
  // in a parent), so placement and data-motion-side are final before entering.
  useLayoutEffect(() => {
    if (!open) return
    entered.current = true
    for (const [kind, element] of targets.current) {
      markExiting(element, false)
      playEnter(element, kind)
    }
  }, [open])

  useLayoutEffect(() => {
    if (open || !exiting) return undefined
    entered.current = false
    const elements = [...targets.current]
    if (elements.length === 0) {
      setLingering(false)
      return undefined
    }
    let pending = elements.length
    const done = (): void => {
      pending -= 1
      if (pending === 0) setLingering(false)
    }
    const abandon = elements.map(([kind, element]) => {
      markExiting(element, true)
      return playExit(element, kind, done)
    })
    return () => abandon.forEach((stop) => stop())
  }, [open, exiting])

  // A stable object, so context consumers re-render only when the lifecycle changes.
  return useMemo(() => ({ mounted, exiting, ref }), [mounted, exiting, ref])
}

/**
 * Keeps showing the last non-empty value while a surface exits, so content
 * that the store already cleared (a closed menu, a resolved prompt) can still
 * animate out.
 */
export function useRetained<T>(value: T | null | undefined, keep: boolean): T | null | undefined {
  const last = useRef(value)
  if (value !== null && value !== undefined) last.current = value
  else if (!keep) last.current = value
  return value ?? (keep ? last.current : value)
}

/** Presence of an enclosing surface mounted by a parent (e.g. App overlays). */
export const PresenceContext = createContext<Presence | null>(null)

/**
 * Ref for a surface's animated part. Inside a PresenceContext it joins that
 * surface's enter/exit; on its own it only plays the entrance on mount.
 */
export function useMotionRef(kind: MotionKind): RefCallback<HTMLElement> {
  const presence = useContext(PresenceContext)
  const presenceRef = presence?.ref(kind)
  const standalone = useCallback((element: HTMLElement | null) => {
    if (element) playEnter(element, kind)
  }, [kind])
  return presenceRef ?? standalone
}

export function usePresenceExiting(): boolean {
  return useContext(PresenceContext)?.exiting ?? false
}

export interface ListEntry<T> {
  key: string
  item: T
  /** Removed from the list and playing its exit; inert, not announced. */
  exiting: boolean
}

/**
 * Enter/exit/reposition for a keyed stack (notifications, downloads). New
 * entries enter, removed ones withdraw in place, then the rest slide to their
 * new places. Geometry is read only when the set of entries changes, never on
 * content updates such as download progress. `immediate` entries (security or
 * update critical) appear at once; motion only affects how they leave.
 */
export function useListPresence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  kind: MotionKind,
  immediate?: (item: T) => boolean
): { entries: ListEntry<T>[]; ref: (key: string) => RefCallback<HTMLElement> } {
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const exitingRef = useRef(new Map<string, { item: T; index: number }>())
  const exitStopRef = useRef(new Map<string, () => void>())
  const elementsRef = useRef(new Map<string, HTMLElement>())
  const callbacksRef = useRef(new Map<string, RefCallback<HTMLElement>>())
  const previousRef = useRef<Map<string, { item: T; index: number }>>(new Map())
  const signatureRef = useRef('')
  const beforeRef = useRef<Map<string, DOMRect> | null>(null)

  const current = new Map(items.map((item, index) => [keyOf(item), { item, index }]))
  for (const [key, previous] of previousRef.current) {
    if (!current.has(key) && !exitingRef.current.has(key) && level !== 'off' && elementsRef.current.get(key)?.isConnected) exitingRef.current.set(key, previous)
  }
  for (const key of current.keys()) exitingRef.current.delete(key)
  previousRef.current = current

  const entries: ListEntry<T>[] = items.map((item) => ({ key: keyOf(item), item, exiting: false }))
  for (const [key, { item, index }] of exitingRef.current) entries.splice(Math.min(index, entries.length), 0, { key, item, exiting: true })
  const signature = entries.map((entry) => `${entry.key}${entry.exiting ? '~' : ''}`).join('|')
  // The DOM still shows the previous set: read where everything is now.
  if (signature !== signatureRef.current && level !== 'off' && elementsRef.current.size > 0) {
    const before = new Map<string, DOMRect>()
    for (const [key, element] of elementsRef.current) if (element.isConnected) before.set(key, element.getBoundingClientRect())
    beforeRef.current = before
  }

  useLayoutEffect(() => {
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    const before = beforeRef.current
    beforeRef.current = null
    for (const entry of entries) {
      const element = elementsRef.current.get(entry.key)
      if (!element) continue
      if (entry.exiting) {
        if (exitStopRef.current.has(entry.key)) continue
        markExiting(element, true)
        exitStopRef.current.set(entry.key, playExit(element, kind, () => {
          exitStopRef.current.delete(entry.key)
          exitingRef.current.delete(entry.key)
          rerender()
        }))
        continue
      }
      const stopExit = exitStopRef.current.get(entry.key)
      if (stopExit) {
        // Re-added while leaving: come back from where it is.
        stopExit()
        exitStopRef.current.delete(entry.key)
        markExiting(element, false)
        playEnter(element, kind)
        continue
      }
      const rect = before?.get(entry.key)
      if (!rect) {
        if (!immediate?.(entry.item)) playEnter(element, kind)
        continue
      }
      const now = element.getBoundingClientRect()
      playMove(element, rect.left - now.left, rect.top - now.top)
    }
  })

  useLayoutEffect(() => () => {
    for (const stop of exitStopRef.current.values()) stop()
  }, [])

  const ref = useCallback((key: string): RefCallback<HTMLElement> => {
    let callback = callbacksRef.current.get(key)
    if (!callback) {
      callback = (element) => {
        if (element) elementsRef.current.set(key, element)
        else {
          elementsRef.current.delete(key)
          callbacksRef.current.delete(key)
        }
      }
      callbacksRef.current.set(key, callback)
    }
    return callback
  }, [])

  return { entries, ref }
}
