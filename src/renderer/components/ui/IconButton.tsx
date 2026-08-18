import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  tooltip?: string
  children: ReactNode
}

export function IconButton({ active, tooltip, className, children, ...props }: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={tooltip}
      className={clsx(
        'no-drag grid h-9 w-9 place-items-center rounded-xl border border-white/[0.045] bg-white/[0.026] text-vast-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition duration-150 ease-smooth hover:border-white/[0.12] hover:bg-white/[0.085] hover:text-white hover:shadow-[0_10px_26px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.055)] disabled:cursor-not-allowed disabled:opacity-40',
        active && 'border-vast-cyan/[0.35] bg-vast-cyan/10 text-vast-cyan shadow-glow',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
