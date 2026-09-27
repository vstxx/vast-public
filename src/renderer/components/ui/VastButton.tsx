import { clsx } from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export type VastButtonVariant = 'primary' | 'secondary' | 'ghost' | 'selected' | 'danger' | 'quiet'
export type VastButtonSize = 'xs' | 'sm' | 'md'

interface VastButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: VastButtonVariant
  size?: VastButtonSize
  icon?: ReactNode
}

/**
 * Shared semantic text button for the whole browser. Styling lives in the
 * `.vast-button` token family in styles/index.css so variant looks stay
 * consistent with icon buttons, menu items and choices.
 */
export const VastButton = forwardRef<HTMLButtonElement, VastButtonProps>(function VastButton(
  { variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...props },
  ref
): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('vast-button', `vast-button--${variant}`, `vast-button--${size}`, className)}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
})
