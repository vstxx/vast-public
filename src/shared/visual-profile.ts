import { DEFAULT_SETTINGS } from './constants.ts'
import { resolveLayoutMode } from './layout-mode.ts'
import type { BrowserSettings, LayoutMode, NewTabBackground, SidebarDensity, ThemePreference } from './types'

// Visual Profiles: portable snapshots of the Settings > Appearance page and
// nothing else. FIELDS is the maintained allowlist; a control added to the
// Appearance page must be added here (and to its round-trip test).

export const VISUAL_PROFILE_FORMAT = 'vast.visual-profile'
export const VISUAL_PROFILE_VERSION = 1
export const VISUAL_PROFILE_EXTENSION = 'vastvisual'
export const VISUAL_PROFILE_NAME_MAX = 48
/** Upper bound for a whole `.vastvisual` file, checked before parsing. */
export const VISUAL_PROFILE_MAX_FILE_BYTES = 6 * 1024 * 1024
/** Upper bound for the optional New Tab image carried by a profile. */
export const VISUAL_PROFILE_MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const VISUAL_PROFILE_IMAGE_TYPES = ['image/png', 'image/jpeg'] as const
export type VisualProfileImageType = typeof VISUAL_PROFILE_IMAGE_TYPES[number]

export interface VisualProfileValues {
  theme: ThemePreference
  layoutMode: LayoutMode
  accentColor: string
  secondaryAccentColor: string
  backgroundTintColor: string
  surfaceTintColor: string
  forceDarkModeWebsites: boolean
  animations: boolean
  openingAnimation: boolean
  openingAnimationSoundVolume: number
  bookmarksBarVisible: boolean
  bookmarksBarOnlyOnNewTab: boolean
  cleanToolbarIcons: boolean
  sidebarDensity: SidebarDensity
  sidePanelMode: BrowserSettings['sidePanel']['mode']
  sidePanelWidth: number
  sidePanelShowLabels: boolean
  newTabBackground: NewTabBackground
  cornerRadius: number
  blurIntensity: number
  transparency: number
  glassIntensity: number
  glowIntensity: number
  borderIntensity: number
  shadowIntensity: number
  gradientIntensity: number
  panelOpacity: number
  saturation: number
}

type Field =
  | { kind: 'color' }
  | { kind: 'boolean' }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }

const percent = { kind: 'integer', min: 0, max: 100 } as const

export const VISUAL_PROFILE_FIELDS: Readonly<Record<keyof VisualProfileValues, Field>> = Object.freeze({
  theme: { kind: 'enum', values: ['dark', 'dim', 'light', 'system'] },
  layoutMode: { kind: 'enum', values: ['vertical', 'horizontal', 'purist'] },
  accentColor: { kind: 'color' },
  secondaryAccentColor: { kind: 'color' },
  backgroundTintColor: { kind: 'color' },
  surfaceTintColor: { kind: 'color' },
  forceDarkModeWebsites: { kind: 'boolean' },
  animations: { kind: 'boolean' },
  openingAnimation: { kind: 'boolean' },
  openingAnimationSoundVolume: percent,
  bookmarksBarVisible: { kind: 'boolean' },
  bookmarksBarOnlyOnNewTab: { kind: 'boolean' },
  cleanToolbarIcons: { kind: 'boolean' },
  sidebarDensity: { kind: 'enum', values: ['comfortable', 'compact'] },
  sidePanelMode: { kind: 'enum', values: ['auto', 'docked', 'overlay'] },
  sidePanelWidth: { kind: 'integer', min: 304, max: 520 },
  sidePanelShowLabels: { kind: 'boolean' },
  newTabBackground: { kind: 'enum', values: ['space-black', 'accent-gradient', 'carbon-black', 'depth', 'adaptive', 'custom'] },
  cornerRadius: { kind: 'integer', min: 6, max: 36 },
  blurIntensity: percent,
  transparency: percent,
  glassIntensity: percent,
  glowIntensity: percent,
  borderIntensity: percent,
  shadowIntensity: percent,
  gradientIntensity: percent,
  panelOpacity: percent,
  saturation: { kind: 'integer', min: 80, max: 145 }
})

const FIELD_KEYS = Object.keys(VISUAL_PROFILE_FIELDS) as Array<keyof VisualProfileValues>
const COLOR = /^#[0-9a-f]{6}$/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validField(field: Field, value: unknown): boolean {
  switch (field.kind) {
    case 'color': return typeof value === 'string' && COLOR.test(value)
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && value >= field.min && value <= field.max
    case 'enum': return typeof value === 'string' && field.values.includes(value)
  }
}

/** Exactly the allowlisted keys with valid values, copied into a fresh object. */
export function parseVisualProfileValues(input: unknown): VisualProfileValues {
  if (!isPlainObject(input)) throw new Error('The appearance values are not a valid object.')
  const keys = Object.keys(input)
  const unexpected = keys.find((key) => !Object.hasOwn(VISUAL_PROFILE_FIELDS, key))
  if (unexpected !== undefined) throw new Error(`Unsupported appearance setting "${unexpected.slice(0, 40)}".`)
  const values: Record<string, unknown> = {}
  for (const key of FIELD_KEYS) {
    if (!Object.hasOwn(input, key)) throw new Error(`Missing appearance setting "${key}".`)
    const value = input[key]
    if (!validField(VISUAL_PROFILE_FIELDS[key], value)) throw new Error(`Invalid value for appearance setting "${key}".`)
    values[key] = VISUAL_PROFILE_FIELDS[key].kind === 'color' ? (value as string).toLowerCase() : value
  }
  return values as unknown as VisualProfileValues
}

function readFromSettings(settings: BrowserSettings): Record<keyof VisualProfileValues, unknown> {
  return {
    theme: settings.theme,
    layoutMode: settings.layoutMode,
    accentColor: settings.accentColor,
    secondaryAccentColor: settings.appearance.secondaryAccentColor,
    backgroundTintColor: settings.appearance.backgroundTintColor,
    surfaceTintColor: settings.appearance.surfaceTintColor,
    forceDarkModeWebsites: settings.appearance.forceDarkModeWebsites,
    animations: settings.animations,
    openingAnimation: settings.openingAnimation,
    openingAnimationSoundVolume: settings.openingAnimationSoundVolume,
    bookmarksBarVisible: settings.bookmarksBarVisible,
    bookmarksBarOnlyOnNewTab: settings.bookmarksBarOnlyOnNewTab,
    cleanToolbarIcons: settings.appearance.cleanToolbarIcons,
    sidebarDensity: settings.sidebarDensity,
    sidePanelMode: settings.sidePanel.mode,
    sidePanelWidth: settings.sidePanel.width,
    sidePanelShowLabels: settings.sidePanel.showLabels,
    newTabBackground: settings.newTab.background,
    cornerRadius: settings.appearance.cornerRadius,
    blurIntensity: settings.appearance.blurIntensity,
    transparency: settings.appearance.transparency,
    glassIntensity: settings.appearance.glassIntensity,
    glowIntensity: settings.appearance.glowIntensity,
    borderIntensity: settings.appearance.borderIntensity,
    shadowIntensity: settings.appearance.shadowIntensity,
    gradientIntensity: settings.appearance.gradientIntensity,
    panelOpacity: settings.appearance.panelOpacity,
    saturation: settings.appearance.saturation
  }
}

/**
 * Snapshot of the current Appearance page. Values an extension theme or an
 * older version left outside the page's range are brought back inside it
 * (rounded, clamped) or replaced by the default, so a snapshot always parses.
 */
export function visualProfileValuesFromSettings(settings: BrowserSettings): VisualProfileValues {
  const current = readFromSettings(settings)
  const fallback = readFromSettings(DEFAULT_SETTINGS)
  const values: Record<string, unknown> = {}
  for (const key of FIELD_KEYS) {
    const field = VISUAL_PROFILE_FIELDS[key]
    let value = current[key]
    if (field.kind === 'integer' && typeof value === 'number' && Number.isFinite(value)) {
      value = Math.min(field.max, Math.max(field.min, Math.round(value)))
    }
    if (field.kind === 'color' && typeof value === 'string') value = value.toLowerCase()
    values[key] = validField(field, value) ? value : fallback[key]
  }
  return values as unknown as VisualProfileValues
}

export const DEFAULT_VISUAL_PROFILE_VALUES: VisualProfileValues = Object.freeze(visualProfileValuesFromSettings(DEFAULT_SETTINGS))

/** The single settings update that applies a profile. Built field by field. */
export function visualProfileSettingsPatch(values: VisualProfileValues) {
  return {
    theme: values.theme,
    layoutMode: values.layoutMode,
    accentColor: values.accentColor,
    animations: values.animations,
    openingAnimation: values.openingAnimation,
    openingAnimationSoundVolume: values.openingAnimationSoundVolume,
    bookmarksBarVisible: values.bookmarksBarVisible,
    bookmarksBarOnlyOnNewTab: values.bookmarksBarOnlyOnNewTab,
    sidebarDensity: values.sidebarDensity,
    appearance: {
      secondaryAccentColor: values.secondaryAccentColor,
      backgroundTintColor: values.backgroundTintColor,
      surfaceTintColor: values.surfaceTintColor,
      forceDarkModeWebsites: values.forceDarkModeWebsites,
      cleanToolbarIcons: values.cleanToolbarIcons,
      cornerRadius: values.cornerRadius,
      blurIntensity: values.blurIntensity,
      transparency: values.transparency,
      glassIntensity: values.glassIntensity,
      glowIntensity: values.glowIntensity,
      borderIntensity: values.borderIntensity,
      shadowIntensity: values.shadowIntensity,
      gradientIntensity: values.gradientIntensity,
      panelOpacity: values.panelOpacity,
      saturation: values.saturation
    },
    sidePanel: {
      mode: values.sidePanelMode,
      width: values.sidePanelWidth,
      showLabels: values.sidePanelShowLabels
    },
    newTab: {
      background: values.newTabBackground
    }
  }
}

export function sameVisualProfileValues(left: VisualProfileValues, right: VisualProfileValues): boolean {
  return FIELD_KEYS.every((key) => left[key] === right[key])
}

/**
 * Trims and collapses whitespace and drops control and bidi-override
 * characters, so a name cannot disguise itself in lists or file names.
 */
export function normalizeVisualProfileName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Enter a profile name.')
  const name = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) throw new Error('Enter a profile name.')
  if ([...name].length > VISUAL_PROFILE_NAME_MAX) throw new Error(`Use ${VISUAL_PROFILE_NAME_MAX} characters or fewer.`)
  return name
}

/** "Midnight" -> "Midnight 2" while the name is taken (case-insensitive). */
export function uniqueVisualProfileName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((item) => item.toLocaleLowerCase()))
  if (!used.has(name.toLocaleLowerCase())) return name
  for (let index = 2; index < 1_000; index += 1) {
    const suffix = ` ${index}`
    const candidate = `${[...name].slice(0, VISUAL_PROFILE_NAME_MAX - suffix.length).join('').trimEnd()}${suffix}`
    if (!used.has(candidate.toLocaleLowerCase())) return candidate
  }
  throw new Error('Too many profiles share this name.')
}

export interface VisualProfileDocument {
  name: string
  values: VisualProfileValues
  image?: { type: VisualProfileImageType; data: string }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const MAX_IMAGE_BASE64 = Math.ceil(VISUAL_PROFILE_MAX_IMAGE_BYTES / 3) * 4

/**
 * Parses an untrusted `.vastvisual` text into fresh trusted values. Image bytes
 * are only shape-checked here; the main process decodes and verifies them.
 */
export function parseVisualProfileDocument(text: string): VisualProfileDocument {
  if (typeof text !== 'string' || text.length > VISUAL_PROFILE_MAX_FILE_BYTES) throw new Error('This file is too large to be a visual profile.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('This file is not a valid visual profile.')
  }
  if (!isPlainObject(parsed)) throw new Error('This file is not a valid visual profile.')
  if (parsed.format !== VISUAL_PROFILE_FORMAT) throw new Error('This file is not a Vast visual profile.')
  if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version)) throw new Error('This visual profile has an invalid version.')
  if (parsed.version > VISUAL_PROFILE_VERSION) throw new Error('This visual profile was made by a newer version of Vast.')
  if (parsed.version !== VISUAL_PROFILE_VERSION) throw new Error('This visual profile version is not supported.')
  const allowed = new Set(['format', 'version', 'name', 'appearance', 'image'])
  const unexpected = Object.keys(parsed).find((key) => !allowed.has(key))
  if (unexpected !== undefined) throw new Error(`This visual profile contains an unsupported field "${unexpected.slice(0, 40)}".`)
  const name = normalizeVisualProfileName(parsed.name)
  const values = parseVisualProfileValues(parsed.appearance)
  if (parsed.image === undefined) return { name, values }
  if (values.newTabBackground !== 'custom') throw new Error('This visual profile carries an image it does not use.')
  const image = parsed.image
  if (!isPlainObject(image) || Object.keys(image).some((key) => key !== 'type' && key !== 'data')) throw new Error('This visual profile has an invalid image.')
  if (!VISUAL_PROFILE_IMAGE_TYPES.includes(image.type as VisualProfileImageType)) throw new Error('Visual profile images must be PNG or JPEG.')
  if (typeof image.data !== 'string' || !image.data || image.data.length % 4 !== 0 || !BASE64.test(image.data)) throw new Error('This visual profile has an invalid image.')
  if (image.data.length > MAX_IMAGE_BASE64) throw new Error('The image in this visual profile is too large.')
  return { name, values, image: { type: image.type as VisualProfileImageType, data: image.data } }
}

export function serializeVisualProfileDocument(document: VisualProfileDocument): string {
  const output: Record<string, unknown> = {
    format: VISUAL_PROFILE_FORMAT,
    version: VISUAL_PROFILE_VERSION,
    name: normalizeVisualProfileName(document.name),
    appearance: parseVisualProfileValues(document.values)
  }
  if (document.image) output.image = { type: document.image.type, data: document.image.data }
  return `${JSON.stringify(output, null, 2)}\n`
}

/** Layout the profile actually produces under the current Labs setting. */
export function effectiveVisualProfileValues(values: VisualProfileValues, experimentalFeatures: boolean): VisualProfileValues {
  const layoutMode = resolveLayoutMode(values.layoutMode, experimentalFeatures)
  return layoutMode === values.layoutMode ? values : { ...values, layoutMode }
}
