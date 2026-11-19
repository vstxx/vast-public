import { isLanguageCode } from './catalog.ts'

export type DisplayMode = 'replace' | 'bilingual'

export interface Settings {
  version: 1
  // null follows the interface language.
  targetLanguage: string | null
  displayMode: DisplayMode
  // A small button next to selected text. Off by default; enabling it registers a tiny content
  // script on websites, which the options page explains.
  selectionButton: boolean
  alwaysTranslate: string[]
  neverTranslateLanguages: string[]
  neverTranslateSites: string[]
  // How long the engine stays warm after the last translation.
  idleSeconds: number
}

export const SETTINGS_KEY = 'settings'

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1,
  targetLanguage: null,
  displayMode: 'replace',
  selectionButton: false,
  alwaysTranslate: [],
  neverTranslateLanguages: [],
  neverTranslateSites: [],
  idleSeconds: 30
})

export const IDLE_SECONDS_RANGE = { min: 10, max: 600 } as const
const MAX_LIST = 200
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeHost(value: string): string | null {
  let host = value.trim().toLowerCase()
  if (!host) return null
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname
    } catch {
      return null
    }
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  return HOST.test(host) ? host : null
}

function languages(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isLanguageCode))].slice(0, MAX_LIST) : []
}

// Whatever storage holds is read through this: another version of the extension, or a damaged
// profile, must never put an unexpected type into the running code.
export function sanitizeSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const idle = Number(raw.idleSeconds)
  return {
    version: 1,
    targetLanguage: isLanguageCode(raw.targetLanguage) ? raw.targetLanguage : null,
    displayMode: raw.displayMode === 'bilingual' ? 'bilingual' : 'replace',
    selectionButton: raw.selectionButton === true,
    alwaysTranslate: languages(raw.alwaysTranslate),
    neverTranslateLanguages: languages(raw.neverTranslateLanguages),
    neverTranslateSites: Array.isArray(raw.neverTranslateSites)
      ? [...new Set(raw.neverTranslateSites.map((entry) => typeof entry === 'string' ? normalizeHost(entry) : null).filter((entry): entry is string => entry !== null))].slice(0, MAX_LIST)
      : [],
    idleSeconds: Number.isFinite(idle) ? Math.min(IDLE_SECONDS_RANGE.max, Math.max(IDLE_SECONDS_RANGE.min, Math.round(idle))) : DEFAULT_SETTINGS.idleSeconds
  }
}

export function siteBlocked(settings: Settings, hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (!host) return false
  return settings.neverTranslateSites.some((site) => host === site || host.endsWith(`.${site}`))
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  return sanitizeSettings(stored[SETTINGS_KEY])
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch })
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}
