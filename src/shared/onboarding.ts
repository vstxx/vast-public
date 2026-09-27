import { DEFAULT_SETTINGS, SEARCH_ENGINES } from './constants.ts'
import type { BrowserSettings, PersistedData, SearchEngine } from './types'

/**
 * Onboarding lifecycle state persisted with the rest of the profile. It is
 * optional so profiles stored before this field existed can be migrated
 * explicitly (see main/storage.ts) instead of being pushed through onboarding.
 */
export interface OnboardingState {
  completed: boolean
}

export function onboardingCompleted(data: Pick<PersistedData, 'onboarding'>): boolean {
  return data.onboarding?.completed === true
}

/** Accent swatches shown by onboarding; mirrors the canonical default accent. */
export const ONBOARDING_ACCENTS: ReadonlyArray<{ id: string; value: string }> = [
  { id: 'lilac', value: '#d1a3ff' },
  { id: 'violet', value: '#9f7aea' },
  { id: 'sky', value: '#74cfff' },
  { id: 'mint', value: '#75d6b2' },
  { id: 'amber', value: '#f2a36b' },
  { id: 'rose', value: '#f07fa0' }
]

export const ONBOARDING_RADIUS_MIN = 8
export const ONBOARDING_RADIUS_MAX = 32

export type OnboardingThemeChoice = Exclude<BrowserSettings['theme'], 'system'>

export const ONBOARDING_THEMES: ReadonlyArray<{ id: OnboardingThemeChoice; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'dim', label: 'Dim' },
  { id: 'light', label: 'Light' }
]

/** Search engines offered by onboarding; resolved through SEARCH_ENGINES so ids and names never drift. */
const ONBOARDING_SEARCH_ENGINE_IDS: ReadonlyArray<string> = ['google', 'duckduckgo', 'brave', 'perplexity']

export function onboardingSearchEngines(): ReadonlyArray<SearchEngine> {
  return ONBOARDING_SEARCH_ENGINE_IDS
    .map((id) => SEARCH_ENGINES.find((engine) => engine.id === id))
    .filter((engine): engine is SearchEngine => Boolean(engine))
}

/**
 * New tab backgrounds surfaced by onboarding, expressed in the canonical
 * `newTab.background` values (the preview's "Neutral Slate" is Vast's Depth).
 */
export const ONBOARDING_BACKGROUNDS: ReadonlyArray<{ id: BrowserSettings['newTab']['background']; label: string }> = [
  { id: 'carbon-black', label: 'Carbon Black' },
  { id: 'space-black', label: 'Space Black' },
  { id: 'accent-gradient', label: 'Accent Gradient' },
  { id: 'depth', label: 'Depth' }
]

/**
 * Settings the onboarding "Use defaults" route resets to their canonical
 * defaults. Sourced live from DEFAULT_SETTINGS so the two never drift.
 */
export function onboardingDefaultChoices(): {
  theme: BrowserSettings['theme']
  accentColor: string
  cornerRadius: number
  defaultSearchEngine: string
  newTabBackground: BrowserSettings['newTab']['background']
} {
  return {
    theme: DEFAULT_SETTINGS.theme,
    accentColor: DEFAULT_SETTINGS.accentColor,
    cornerRadius: DEFAULT_SETTINGS.appearance.cornerRadius,
    defaultSearchEngine: DEFAULT_SETTINGS.defaultSearchEngine,
    newTabBackground: DEFAULT_SETTINGS.newTab.background
  }
}
