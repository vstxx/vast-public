import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useMotionRef, usePresenceExiting } from '../../lib/motion'

export function ModalShell({
  children,
  onClose,
  width = 'max-w-3xl',
  className = '',
  overlayClassName = '',
  panelStyle,
  overlayStyle,
  placement = 'start',
  ariaLabel,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  motionImmediate = false
}: {
  children: ReactNode
  onClose: () => void
  width?: string
  className?: string
  overlayClassName?: string
  panelStyle?: CSSProperties
  overlayStyle?: CSSProperties
  placement?: 'start' | 'center'
  ariaLabel?: string
  dismissOnBackdrop?: boolean
  dismissOnEscape?: boolean
  /** Appear without an entrance (critical notices); the exit still animates. */
  motionImmediate?: boolean
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const backdropMotionRef = useMotionRef('backdrop')
  const panelMotionRef = useMotionRef('dialog')
  const setPanel = useCallback((element: HTMLDivElement | null) => {
    panelRef.current = element
    panelMotionRef(element)
  }, [panelMotionRef])
  // While the dialog plays its exit it is already closed: focus returns and
  // the keyboard trap is released right away, not when the motion ends.
  const exiting = usePresenceExiting()
  const onCloseRef = useRef(onClose)
  const dismissOnEscapeRef = useRef(dismissOnEscape)

  useEffect(() => {
    onCloseRef.current = onClose
    dismissOnEscapeRef.current = dismissOnEscape
  }, [onClose, dismissOnEscape])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel || exiting) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    ;(focusable()[0] ?? panel).focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // A dropdown or menu inside the dialog that handled Escape closes
        // only itself, not the whole dialog.
        if (event.defaultPrevented) return
        event.preventDefault()
        if (dismissOnEscapeRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Only reclaim focus that is still inside the dialog or lost to <body>.
      if (!document.activeElement || document.activeElement === document.body || panel.contains(document.activeElement)) previousFocus?.focus()
    }
  }, [exiting])

  return (
    // Background blur. Inline because the minified CSS keeps only the -webkit-
    // copy of backdrop-filter, which Chromium ignores.
    <div ref={backdropMotionRef} data-motion-immediate={motionImmediate || undefined} style={{ backdropFilter: 'blur(var(--vast-dialog-backdrop-blur))', ...overlayStyle }} className={`fixed inset-0 z-50 flex justify-center bg-black/[0.55] px-5 ${overlayClassName} ${placement === 'center' ? 'items-center py-5' : 'items-start py-[8vh]'}`}>
      {dismissOnBackdrop && <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />}
      <div ref={setPanel} data-motion-immediate={motionImmediate || undefined} style={panelStyle} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1} className={`relative max-h-[84vh] w-full ${width} vast-modal-surface overflow-hidden rounded-modal border border-white/12 shadow-glass ${className}`}>
        {children}
      </div>
    </div>
  )
}
