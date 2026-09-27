import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const HOVER_DWELL_MS = 700
const FOCUS_DWELL_MS = 400
const LONG_PRESS_MS = 650
const VIEWPORT_PADDING = 12
const HINT_GAP = 10

/**
 * Contextual help for a single setting row. The text stays out of the layout
 * and only surfaces after a deliberate hover dwell, keyboard focus dwell, or
 * long-press. It supplements — never replaces — the row's accessible name.
 */
export function SettingsHint({ help, children }: { help: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const hintRef = useRef<HTMLSpanElement | null>(null)
  const showTimerRef = useRef<number | null>(null)
  const hintId = useId()

  const clearShowTimer = (): void => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
  }

  const hide = (): void => {
    clearShowTimer()
    setOpen(false)
    setVisible(false)
    setPosition(null)
  }

  const scheduleShow = (delay: number): void => {
    clearShowTimer()
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null
      setOpen(true)
    }, delay)
  }

  useEffect(() => clearShowTimer, [])

  // Keyboard users focus the row's control, not the label text; listen on the row.
  useEffect(() => {
    const trigger = triggerRef.current
    const row = trigger?.closest('label, .settings-row, .settings-feature, .settings-color-item')
    if (!row) return
    const onFocusIn = (): void => scheduleShow(FOCUS_DWELL_MS)
    const onFocusOut = (event: Event): void => {
      const related = (event as FocusEvent).relatedTarget
      if (!row.contains(related instanceof Node ? related : null)) hide()
    }
    row.addEventListener('focusin', onFocusIn)
    row.addEventListener('focusout', onFocusOut)
    return () => {
      row.removeEventListener('focusin', onFocusIn)
      row.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // Measure the rendered hint, then place it above (or below) the trigger.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const hint = hintRef.current
    if (!trigger || !hint) return
    const rect = trigger.getBoundingClientRect()
    const width = hint.offsetWidth
    const height = hint.offsetHeight
    const above = rect.top - height - HINT_GAP >= VIEWPORT_PADDING
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.left + Math.min(rect.width, 180) / 2 - width / 2),
      window.innerWidth - width - VIEWPORT_PADDING
    )
    setPosition({ left, top: above ? rect.top - height - HINT_GAP : rect.bottom + HINT_GAP })
    const frame = window.requestAnimationFrame(() => setVisible(true))
    return () => window.cancelAnimationFrame(frame)
  }, [open, help])

  useEffect(() => {
    if (!open) return
    const dismissOnScroll = (): void => hide()
    const dismissOnKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('scroll', dismissOnScroll, { capture: true, passive: true })
    window.addEventListener('keydown', dismissOnKeyDown)
    return () => {
      window.removeEventListener('scroll', dismissOnScroll, { capture: true })
      window.removeEventListener('keydown', dismissOnKeyDown)
    }
  }, [open])

  return (
    <span
      ref={triggerRef}
      className="settings-hint-trigger"
      aria-describedby={open ? hintId : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') scheduleShow(HOVER_DWELL_MS)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') hide()
      }}
      onPointerDown={(event) => {
        if (event.pointerType === 'touch') scheduleShow(LONG_PRESS_MS)
      }}
      onPointerUp={(event) => {
        if (event.pointerType === 'touch') clearShowTimer()
      }}
      onPointerCancel={hide}
      onPointerMove={(event) => {
        if (event.pointerType === 'touch') clearShowTimer()
      }}
    >
      {children}
      {open &&
        createPortal(
          <span
            id={hintId}
            ref={hintRef}
            role="tooltip"
            className={position && visible ? 'settings-hint is-visible' : 'settings-hint'}
            style={position ?? { visibility: 'hidden' }}
          >
            {help}
          </span>,
          document.body
        )}
    </span>
  )
}
