import type { CSSProperties } from 'react'
import type { BrowserSettings } from '../../shared/types'

// DEFAULT_SETTINGS.appearance.surfaceTintColor; not imported so this module stays free of runtime imports.
const DEFAULT_SURFACE_TINT = '#1d1127'
const NEUTRAL_SURFACE_TINT = '#141414'
// DEFAULT_SETTINGS.appearance.transparency
const DEFAULT_TRANSPARENCY = 15

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
  // Profiles saved before Transparency existed get the default until resaved.
  const transparency = clamp(Number.isFinite(appearance.transparency) ? appearance.transparency : DEFAULT_TRANSPARENCY, 0, 100)
  const saturation = clamp(appearance.saturation, 80, 145)
  // Floating surfaces (side panel, menus, popovers, notifications, dialogs):
  // Transparency 0-100 maps to 100-30 % opacity, a cap that keeps text
  // readable. Frost (the stored glassIntensity) blurs what shows through, up
  // to 20 px, and is skipped when nothing shows through.
  const floatOpacity = 100 - transparency * 0.7
  const surfaceTintIsDefault = appearance.surfaceTintColor.toLowerCase() === DEFAULT_SURFACE_TINT
  const frost = Math.round(glass * 0.2)

  return {
    '--vast-accent': settings.accentColor,
    '--vast-accent-secondary': appearance.secondaryAccentColor,
    '--vast-bg-tint': appearance.backgroundTintColor,
    // The default tint is purple; it renders as a neutral dark gray so the dark
    // theme stays black and gray. A tint the user picks still applies.
    '--vast-surface-tint': surfaceTintIsDefault ? NEUTRAL_SURFACE_TINT : appearance.surfaceTintColor,
    // Dim surfaces stay neutral gray until a surface tint other than the default is chosen.
    '--vast-dim-surface-tint-mix': surfaceTintIsDefault ? '0%' : '22%',
    '--vast-radius-base': `${radius}px`,
    '--vast-frost': `${frost}px`,
    '--vast-saturation': `${(saturation / 100).toFixed(2)}`,
    '--vast-panel-mix': `${Math.round(68 + panel * 0.3)}%`,
    '--vast-address-panel-mix': `${Math.round(58 + panel * 0.28)}%`,
    '--vast-focus-panel-mix': `${Math.round(52 + panel * 0.26)}%`,
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
    '--vast-sheen-soft-alpha': `${(0.01 + glass * 0.00038).toFixed(3)}`,
    '--vast-float-opacity': `${floatOpacity.toFixed(1)}%`,
    '--vast-float-alpha': (floatOpacity / 100).toFixed(3),
    '--vast-float-filter': transparency > 0 && frost > 0 ? `blur(${frost}px) saturate(${(saturation / 100).toFixed(2)})` : 'none',
    // Background blur: the dimmed backdrop behind Settings, the palette and dialogs.
    '--vast-dialog-backdrop-blur': `${Math.round(blur * 0.12)}px`,
    '--vast-toolbar-icon-size': appearance.cleanToolbarIcons ? '18px' : '16px'
  } as CSSProperties
}
