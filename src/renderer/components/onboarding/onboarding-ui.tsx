import type { ReactNode } from 'react'
import type { BrowserSettings } from '../../../shared/types'
import { ONBOARDING_ACCENTS, ONBOARDING_THEMES } from '../../../shared/onboarding'

export function GroupLabel({ children }: { children: ReactNode }): JSX.Element {
  return <div className="onboarding-group-label">{children}</div>
}

export function Group({ label, children, className }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`onboarding-group ${className ?? ''}`}>
      <GroupLabel>{label}</GroupLabel>
      {children}
    </div>
  )
}

export function ThemeChoiceGrid({ value, onChange }: { value: string; onChange: (theme: string) => void }): JSX.Element {
  return (
    <div className="onboarding-choice-grid" role="radiogroup" aria-label="Theme">
      {ONBOARDING_THEMES.map((theme) => (
        <button
          key={theme.id}
          type="button"
          role="radio"
          aria-checked={value === theme.id}
          className={`onboarding-choice ${value === theme.id ? 'is-selected' : ''}`}
          onClick={() => onChange(theme.id)}
        >
          <span className={`onboarding-theme-chip onboarding-theme-chip--${theme.id}`} aria-hidden="true" />
          <span className="onboarding-choice-title">{theme.label}</span>
        </button>
      ))}
    </div>
  )
}

export function AccentRow({ value, onChange }: { value: string; onChange: (accent: string) => void }): JSX.Element {
  return (
    <div className="onboarding-accent-row" role="radiogroup" aria-label="Accent">
      {ONBOARDING_ACCENTS.map((accent) => (
        <button
          key={accent.id}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === accent.value}
          aria-label={accent.id}
          title={accent.id}
          className={`onboarding-accent vast-geometry-circle ${value.toLowerCase() === accent.value ? 'is-selected' : ''}`}
          onClick={() => onChange(accent.value)}
        >
          <span className="vast-geometry-circle" style={{ background: accent.value }} />
        </button>
      ))}
    </div>
  )
}

export type OnboardingPillOption<T extends string> = { id: T; label: string; hint?: string; disabled?: boolean }

export function PillRow<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  wide
}: {
  value: T | null
  options: ReadonlyArray<OnboardingPillOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
  wide?: boolean
}): JSX.Element {
  return (
    <div className={`onboarding-pills ${wide ? 'onboarding-pills--wide' : ''}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={option.disabled}
          title={option.hint}
          className={`vast-button vast-button--secondary ${value === option.id ? 'vast-button--selected' : ''} ${wide ? 'onboarding-pill-wide' : ''}`}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function TogglePillRow<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: ReadonlyArray<T>
  options: ReadonlyArray<OnboardingPillOption<T>>
  onChange: (value: T) => void
  ariaLabel: string
}): JSX.Element {
  return (
    <div className="onboarding-pills onboarding-pills--wide" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = value.includes(option.id)
        return (
          <button
            key={option.id}
            type="button"
            role="checkbox"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.hint}
            className={`vast-button vast-button--secondary ${selected ? 'vast-button--selected' : ''} onboarding-pill-wide`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function OnboardingToggleRow({
  icon,
  title,
  description,
  checked,
  onChange
}: {
  icon: ReactNode
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="onboarding-row">
      <span className="onboarding-row-main">
        <span className="onboarding-row-icon" aria-hidden="true">{icon}</span>
        <span>
          <span className="onboarding-row-title">{title}</span>
          <span className="onboarding-row-desc">{description}</span>
        </span>
      </span>
      <input className="settings-switch" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

export function SummaryChip({ children }: { children: ReactNode }): JSX.Element {
  return <span className="onboarding-summary-chip">{children}</span>
}

export type NewTabBackgroundId = BrowserSettings['newTab']['background']
