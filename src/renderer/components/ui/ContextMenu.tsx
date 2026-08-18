import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBrowserStore } from '../../store/browser-store'

export function ContextMenu(): JSX.Element | null {
  const menu = useBrowserStore((state) => state.contextMenu)
  const close = useBrowserStore((state) => state.closeContextMenu)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [menuSize, setMenuSize] = useState({ width: 240, height: 240 })
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    setPreviewOpen(false)
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
      if (
        target instanceof Node &&
        ((menuRef.current && menuRef.current.contains(target)) ||
          (previewRef.current && previewRef.current.contains(target)))
      ) {
        return
      }
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
  const previewWidth = 260
  const previewGap = 8
  const previewLeft =
    left + menuSize.width + previewGap + previewWidth <= window.innerWidth - viewportPadding
      ? left + menuSize.width + previewGap
      : Math.max(viewportPadding, left - previewWidth - previewGap)
  const previewTop = Math.max(
    viewportPadding,
    Math.min(top, window.innerHeight - 132 - viewportPadding)
  )

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close context menu"
        className="fixed inset-0 z-[2147483645] cursor-default bg-transparent"
        onMouseDown={close}
      />
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[2147483646] max-h-[min(78vh,34rem)] w-[15rem] overflow-y-auto overflow-x-hidden rounded-2xl border border-white/10 bg-[#090a0d]/[0.98] p-1 text-sm text-white shadow-glass backdrop-blur-2xl"
        style={{ left, top }}
      >
        {menu.title && (
          <div className="border-b border-white/[0.08] px-2 py-1">
            <div className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-vast-soft">{menu.title}</div>
          </div>
        )}
        {menu.preview && (
          <div className="border-b border-white/[0.08] px-1.5 py-1">
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setPreviewOpen((current) => !current)}
              className="flex min-h-7 w-full items-center justify-between rounded-xl px-2 py-1 text-left text-[12px] font-medium text-vast-soft transition hover:bg-white/[0.075] hover:text-white"
            >
              <span>{previewOpen ? 'Hide preview' : 'Preview'}</span>
              <span className="text-[11px] text-vast-cyan">{menu.preview.host}</span>
            </button>
          </div>
        )}
        <div className="py-0.5">
          {menu.items.map((item) =>
            item.separator ? (
              <div key={item.id} className="my-0.5 h-px bg-white/[0.08]" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (item.disabled) return
                  close()
                  void item.action?.()
                }}
                className={`flex min-h-7 w-full items-center gap-1.5 rounded-xl px-2 py-1 text-left transition ${
                  item.disabled
                    ? 'cursor-not-allowed text-vast-soft/40'
                    : item.danger
                      ? 'text-red-300 hover:bg-red-400/10'
                      : 'text-vast-soft hover:bg-white/[0.075] hover:text-white'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium leading-5">{item.label}</span>
                  {item.detail && <span className="block truncate text-[11px] leading-4 text-vast-soft">{item.detail}</span>}
                </span>
                {item.shortcut && <kbd className="shrink-0 text-[11px] text-vast-soft">{item.shortcut}</kbd>}
              </button>
            )
          )}
        </div>
      </div>
      {menu.preview && previewOpen && (
        <div
          ref={previewRef}
          className="link-preview-card fixed z-[2147483646] w-[280px] rounded-2xl border border-white/10 px-3 py-2.5 text-sm shadow-glass backdrop-blur-2xl"
          style={{ left: previewLeft, top: previewTop }}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-vast-cyan/10 text-vast-cyan">
              <span className="text-xs font-black">{menu.preview.host.slice(0, 1).toUpperCase()}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-white">{menu.preview.host}</div>
              <div className="mt-0.5 truncate text-[11px] text-vast-soft">{menu.preview.url}</div>
              {Boolean(menu.preview.duplicateCount) && (
                <div className="mt-1 text-[11px] text-vast-cyan">
                  {menu.preview.duplicateCount} matching open tab{menu.preview.duplicateCount === 1 ? '' : 's'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  )
}
