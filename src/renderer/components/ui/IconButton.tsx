import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type IconButtonVariant = 'secondary' | 'ghost' | 'quiet' | 'selected' | 'danger'
export type IconButtonSize = 'xs' | 'sm' | 'md'

const sizeClasses: Record<IconButtonSize, string> = {
  xs: 'h-7 w-7',
  sm: 'h-8 w-8',
  md: 'h-9 w-9'
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  variant?: IconButtonVariant
  size?: IconButtonSize
  tooltip?: string
  children: ReactNode
}

export function IconButton({
  active,
  variant = 'secondary',
  size = 'md',
  tooltip,
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps): JSX.Element {
  return (
    <button
      type={type}
      title={tooltip}
      aria-pressed={active}
      className={clsx(
        'no-drag vast-icon-button grid place-items-center rounded-control',
        sizeClasses[size],
        variant !== 'secondary' && `vast-icon-button--${variant}`,
        active && 'is-active',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
