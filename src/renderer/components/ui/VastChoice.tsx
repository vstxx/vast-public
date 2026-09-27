import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface VastChoiceProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  onSelect?: () => void
  children: ReactNode
}

/**
 * Shared selectable choice card for visual pickers (layout, theme, presets).
 * Selection is communicated by the accent border/tint — it is a selectable
 * option, not a CTA, so it never uses button variants.
 */
export function VastChoice({ selected, onSelect, className, children, type = 'button', ...props }: VastChoiceProps): JSX.Element {
  return (
    <button
      type={type}
      aria-pressed={selected}
      onClick={onSelect}
      className={clsx('vast-choice', selected && 'is-selected', className)}
      {...props}
    >
      {children}
    </button>
  )
}
