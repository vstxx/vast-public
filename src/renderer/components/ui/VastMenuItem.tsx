import { clsx } from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export interface VastMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  detail?: string
  shortcut?: string
  selected?: boolean
  danger?: boolean
}

/**
 * Shared menu/list command row for context menus, action menus and compact
 * command surfaces. Shares the focus, hover, selected, danger and disabled
 * tokens of the button family while keeping menu semantics (role=menuitem,
 * tabIndex handled by the menu container).
 */
export const VastMenuItem = forwardRef<HTMLButtonElement, VastMenuItemProps>(function VastMenuItem(
  { icon, detail, shortcut, selected, danger, className, children, type = 'button', role = 'menuitem', tabIndex = -1, ...props },
  ref
): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      role={role}
      tabIndex={tabIndex}
      className={clsx('vast-menu-item', selected && 'is-selected', danger && 'is-danger', className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {detail && <span className="vast-menu-item-detail">{detail}</span>}
      </span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  )
})
