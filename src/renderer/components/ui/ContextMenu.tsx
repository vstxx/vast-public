import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePresence, useRetained } from '../../lib/motion'
import { useBrowserStore } from '../../store/browser-store'
import { VastMenuItem } from './VastMenuItem'

export function ContextMenu(): JSX.Element | null {
  const menu = useBrowserStore((state) => state.contextMenu)
  const close = useBrowserStore((state) => state.closeContextMenu)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [actionError, setActionError] = useState('')
  const [executing, setExecuting] = useState(false)

  useEffect(() => {
    setActionError('')
    setExecuting(false)
  }, [menu])

  useEffect(() => {
    if (!menu) return
    window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
        if (items.length === 0) return
        event.preventDefault()
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const offset = event.key === 'ArrowDown' ? 1 : -1
        items[(current + offset + items.length) % items.length].focus()
      }
    }
    // Scrolling by the user outside the menu dismisses it. Programmatic
    // scrolling (the tab strip easing the active tab into view after a
    // navigation) must not: it used to close a menu before it could be used.
    const onUserScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      close()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('wheel', onUserScroll, { capture: true, passive: true })
    window.addEventListener('touchmove', onUserScroll, { capture: true, passive: true })
    window.addEventListener('resize', onUserScroll)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('wheel', onUserScroll, { capture: true })
      window.removeEventListener('touchmove', onUserScroll, { capture: true })
      window.removeEventListener('resize', onUserScroll)
    }
  }, [close, menu])

  // Placement is final before the first paint: the real size is measured,
  // clamped into the viewport, and the motion grows from the corner nearest
  // the pointer (flipped near the right and bottom edges). Written straight to
  // the DOM so a re-render never moves an open menu.
  useLayoutEffect(() => {
    const element = menuRef.current
    if (!menu || !element) return
    const viewportPadding = 8
    const cursorOffset = 2
    const width = element.offsetWidth
    const height = element.offsetHeight
    const left = Math.max(viewportPadding, Math.min(menu.x + cursorOffset, window.innerWidth - width - viewportPadding))
    const top = Math.max(viewportPadding, Math.min(menu.y + cursorOffset, window.innerHeight - height - viewportPadding))
    const above = top + height <= menu.y + cursorOffset
    const leftward = left + width <= menu.x + cursorOffset
    element.style.left = `${left}px`
    element.style.top = `${top}px`
    element.style.transformOrigin = `${leftward ? 'right' : 'left'} ${above ? 'bottom' : 'top'}`
    element.dataset.motionSide = above ? 'above' : 'below'
  }, [menu])

  // Declared after the placement effect so the entrance starts from the final spot.
  const presence = usePresence(Boolean(menu))
  const shown = useRetained(menu, presence.mounted)
  const motionRef = presence.ref('context')
  const setMenuElement = useCallback((element: HTMLDivElement | null) => {
    menuRef.current = element
    motionRef(element)
  }, [motionRef])
  // A different menu while one is open is a new surface with its own reveal.
  const menuKeyRef = useRef({ menu: shown, key: 0 })
  if (shown && menuKeyRef.current.menu !== shown) menuKeyRef.current = { menu: shown, key: menuKeyRef.current.key + 1 }

  if (!presence.mounted || !shown) return null

  return createPortal(
    <>
      {menu && (
        <button
          type="button"
          aria-label="Close context menu"
          className="no-drag fixed inset-0 z-2147483645 cursor-default bg-transparent"
          onMouseDown={close}
        />
      )}
      <div
        key={menuKeyRef.current.key}
        ref={setMenuElement}
        role="menu"
        aria-hidden={presence.exiting || undefined}
        className="no-drag fixed z-2147483646 max-h-[min(78vh,34rem)] w-60 overflow-y-auto overflow-x-hidden vast-float rounded-card border border-white/10 p-1 text-sm text-white shadow-glass"
      >
        {shown.title && (
          <div className="border-b border-white/8 px-2 py-1">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-vast-soft">{shown.title}</div>
          </div>
        )}
        <div className="py-0.5">
          {shown.items.map((item) =>
            item.separator ? (
              <div key={item.id} className="my-0.5 h-px bg-white/8" />
            ) : (
              <VastMenuItem
                key={item.id}
                danger={item.danger && !item.disabled}
                disabled={item.disabled || executing}
                detail={item.detail}
                shortcut={item.shortcut}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={async () => {
                  if (item.disabled || executing) return
                  setExecuting(true)
                  setActionError('')
                  try {
                    await item.action?.()
                    if (useBrowserStore.getState().contextMenu === shown) close()
                  } catch (error) {
                    setActionError(error instanceof Error ? error.message : 'This action could not be completed.')
                  } finally {
                    setExecuting(false)
                  }
                }}
              >
                {item.label}
              </VastMenuItem>
            )
          )}
        </div>
        {actionError && <p role="alert" className="px-2 py-2 text-xs text-red-300">{actionError}</p>}
      </div>
    </>,
    document.body
  )
}
