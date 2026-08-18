import { useEffect, useRef, type ReactNode } from 'react'

export function ModalShell({
  children,
  onClose,
  width = 'max-w-3xl',
  className = '',
  placement = 'start',
  ariaLabel
}: {
  children: ReactNode
  onClose: () => void
  width?: string
  className?: string
  placement?: 'start' | 'center'
  ariaLabel?: string
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    ;(focusable()[0] ?? panel).focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
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
      previousFocus?.focus()
    }
  }, [])

  return (
    <div className={`fixed inset-0 z-50 flex justify-center bg-black/[0.55] px-5 backdrop-blur-xl ${placement === 'center' ? 'items-center py-5' : 'items-start py-[8vh]'}`}>
      <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1} className={`relative max-h-[84vh] w-full ${width} overflow-hidden rounded-3xl border border-white/[0.12] bg-[#0b0c11]/95 shadow-glass ${className}`}>
        {children}
      </div>
    </div>
  )
}
