import type { CSSProperties } from 'react'
import type { BrowserSettings } from '../../shared/types'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Maps persisted appearance settings onto the runtime CSS custom properties
 * consumed by the browser chrome, Settings, and the Appearance preview.
 * One derivation, everywhere the visual style is rendered.
 */
export function appearanceStyle(settings: Pick<BrowserSettings, 'appearance' | 'accentColor'>): CSSProperties {
  const appearance = settings.appearance
  const radius = clamp(appearance.cornerRadius, 6, 36)
  const glass = clamp(appearance.glassIntensity, 0, 100)
  const blur = clamp(appearance.blurIntensity, 0, 100)
  const glow = clamp(appearance.glowIntensity, 0, 100)
  const border = clamp(appearance.borderIntensity, 0, 100)
  const shadow = clamp(appearance.shadowIntensity, 0, 100)
  const gradient = clamp(appearance.gradientIntensity, 0, 100)
  const panel = clamp(appearance.panelOpacity, 0, 100)
  const chrome = clamp(appearance.chromeOpacity, 0, 100)
  const saturation = clamp(appearance.saturation, 80, 145)

  return {
    '--vast-accent': settings.accentColor,
    '--vast-accent-secondary': appearance.secondaryAccentColor,
    '--vast-bg-tint': appearance.backgroundTintColor,
    '--vast-surface-tint': appearance.surfaceTintColor,
    '--vast-radius-base': `${radius}px`,
    '--vast-blur': `${Math.round(8 + blur * 0.32)}px`,
    '--vast-saturation': `${(saturation / 100).toFixed(2)}`,
    '--vast-panel-mix': `${Math.round(68 + panel * 0.3)}%`,
    '--vast-address-panel-mix': `${Math.round(58 + panel * 0.28)}%`,
    '--vast-focus-panel-mix': `${Math.round(52 + panel * 0.26)}%`,
    '--vast-surface-mix': `${Math.round(34 + glass * 0.56)}%`,
    '--vast-border-mix': `${Math.round(10 + border * 0.62)}%`,
    '--vast-border-soft-mix': `${Math.round(7 + border * 0.42)}%`,
    '--vast-address-border-mix': `${Math.round(6 + border * 0.42)}%`,
    '--vast-focus-border-mix': `${Math.round(8 + border * 0.32)}%`,
    '--vast-glow-mix': `${Math.round(2 + glow * 0.32)}%`,
    '--vast-glow-soft-mix': `${Math.round(1 + glow * 0.14)}%`,
    '--vast-focus-glow-mix': `${Math.round(4 + glow * 0.36)}%`,
    '--vast-shadow-alpha': `${(0.08 + shadow * 0.0042).toFixed(3)}`,
    '--vast-address-shadow-alpha': `${(0.06 + shadow * 0.0032).toFixed(3)}`,
    '--vast-focus-shadow-alpha': `${(0.07 + shadow * 0.0037).toFixed(3)}`,
    '--vast-gradient-mix': `${Math.round(gradient * 0.22)}%`,
    '--vast-gradient-soft-mix': `${Math.round(gradient * 0.11)}%`,
    '--vast-gradient-strong-mix': `${Math.round(8 + gradient * 0.26)}%`,
    '--vast-chrome-alpha': `${(0.48 + chrome * 0.005).toFixed(3)}`,
    '--vast-chrome-mix': `${Math.round(48 + chrome * 0.5)}%`,
    '--vast-sheen-alpha': `${(0.014 + glass * 0.0007).toFixed(3)}`,
    '--vast-sheen-soft-alpha': `${(0.01 + glass * 0.00038).toFixed(3)}`,
    '--vast-toolbar-icon-size': appearance.cleanToolbarIcons ? '18px' : '16px'
  } as CSSProperties
}
