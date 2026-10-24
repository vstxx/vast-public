import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBrowserStore } from '../../store/browser-store'
import { VastMenuItem } from './VastMenuItem'

export function ContextMenu(): JSX.Element | null {
  const menu = useBrowserStore((state) => state.contextMenu)
  const close = useBrowserStore((state) => state.closeContextMenu)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuSize, setMenuSize] = useState({ width: 240, height: 240 })
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
    const onScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      close()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
    }
  }, [close, menu])

  useLayoutEffect(() => {
    if (!menu) return
    const element = menuRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setMenuSize((current) =>
      current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height }
    )
  }, [menu])

  if (!menu) return null

  const viewportPadding = 8
  const cursorOffset = 2
  const left = Math.max(
    viewportPadding,
    Math.min(menu.x + cursorOffset, window.innerWidth - menuSize.width - viewportPadding)
  )
  const top = Math.max(
    viewportPadding,
    Math.min(menu.y + cursorOffset, window.innerHeight - menuSize.height - viewportPadding)
  )

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close context menu"
        className="no-drag fixed inset-0 z-2147483645 cursor-default bg-transparent"
        onMouseDown={close}
      />
      <div
        ref={menuRef}
        role="menu"
        className="no-drag fixed z-2147483646 max-h-[min(78vh,34rem)] w-60 overflow-y-auto overflow-x-hidden vast-float rounded-card border border-white/10 p-1 text-sm text-white shadow-glass"
        style={{ left, top }}
      >
        {menu.title && (
          <div className="border-b border-white/8 px-2 py-1">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-vast-soft">{menu.title}</div>
          </div>
        )}
        <div className="py-0.5">
          {menu.items.map((item) =>
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
                    if (useBrowserStore.getState().contextMenu === menu) close()
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
