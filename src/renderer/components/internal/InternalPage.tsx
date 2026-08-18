import { Loader2, type LucideIcon } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'

export function InternalPageShell({
  children,
  className = '',
  ...props
}: {
  children: ReactNode
  className?: string
} & HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div {...props} className={`internal-page-shell ${className}`.trim()}>
      {children}
    </div>
  )
}

export function InternalPageHero({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
  children,
  className = ''
}: {
  icon?: LucideIcon
  eyebrow?: string
  title: string
  description: string
  actions?: ReactNode
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`vast-glass-panel internal-page-section internal-page-enter rounded-[32px] p-6 md:p-7 ${className}`}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          {eyebrow && (
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.045] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-vast-soft">
              {Icon && <Icon className="h-3.5 w-3.5 text-vast-cyan" />}
              {eyebrow}
            </div>
          )}
          <h1 className="text-4xl font-semibold tracking-tight text-white md:text-5xl">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-vast-soft md:text-[15px]">{description}</p>
          {children && <div className="mt-5">{children}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </section>
  )
}

export function InternalPageSection({
  icon: Icon,
  title,
  description,
  action,
  children,
  className = ''
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`vast-glass-panel internal-page-section internal-page-enter rounded-[28px] p-5 ${className}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            {Icon && <Icon className="h-4 w-4 text-vast-cyan" />}
            {title}
          </div>
          {description && <p className="mt-1 max-w-2xl text-xs leading-5 text-vast-soft">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function InternalMetricCard({
  icon: Icon,
  label,
  value,
  hint
}: {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
}): JSX.Element {
  return (
    <div className="vast-glass-panel internal-page-enter min-h-[112px] rounded-[24px] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-vast-soft">{label}</span>
        <Icon className="h-4 w-4 text-vast-cyan" />
      </div>
      <div className="mt-3 text-3xl font-semibold text-white">{value}</div>
      {hint && <div className="mt-1 text-xs text-vast-soft">{hint}</div>}
    </div>
  )
}

export function InternalEmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = ''
}: {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={`grid min-h-[220px] place-items-center rounded-[26px] border border-dashed border-white/[0.1] bg-white/[0.03] p-8 text-center ${className}`}>
      <div className="max-w-md">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.05] text-vast-cyan">
          <Icon className="h-5 w-5" />
        </div>
        <div className="mt-4 text-lg font-semibold text-white">{title}</div>
        <p className="mt-2 text-sm leading-6 text-vast-soft">{description}</p>
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  )
}

export function InternalLoadingSkeleton({
  title = 'Loading',
  lines = 4,
  className = ''
}: {
  title?: string
  lines?: number
  className?: string
}): JSX.Element {
  return (
    <div className={`rounded-[26px] border border-white/[0.08] bg-white/[0.03] p-5 ${className}`}>
      <div className="flex items-center gap-2 text-sm font-semibold text-white">
        <Loader2 className="h-4 w-4 animate-spin text-vast-cyan" />
        {title}
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: lines }, (_item, index) => (
          <div key={`${title}-${index}`} className={`internal-skeleton h-3 rounded-full ${index === 0 ? 'w-2/3' : index === lines - 1 ? 'w-1/2' : 'w-full'}`} />
        ))}
      </div>
    </div>
  )
}
