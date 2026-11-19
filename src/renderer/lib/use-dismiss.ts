import { useEffect, useRef, type RefObject } from 'react'

/**
 * Closes an anchored menu on Escape or a pointer press outside `container`
 * (which should hold both the trigger and the menu, so the trigger keeps
 * toggling). Listens only while open.
 */
export function useDismiss(open: boolean, container: RefObject<HTMLElement | null>, onDismiss: () => void): void {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && container.current?.contains(event.target)) return
      dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismissRef.current()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [container, open])
}
