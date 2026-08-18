import type { BrowserSettings } from './types'

const OPENING_STARTUP_FLAG_PREFIX = '--vast-opening-startup='
const OPENING_STARTUP_VOLUME_FLAG_PREFIX = '--vast-opening-volume='
const OPENING_STARTUP_HANDLED_FLAG_PREFIX = '--vast-opening-handled='
export const OPENING_STARTUP_QUERY_PARAM = 'vastOpening'
export const OPENING_STARTUP_VOLUME_QUERY_PARAM = 'vastOpeningVolume'
export const OPENING_STARTUP_HANDLED_QUERY_PARAM = 'vastOpeningHandled'

export function isOpeningAnimationEnabled(
  settings: Pick<BrowserSettings, 'animations' | 'openingAnimation'>
): boolean {
  return settings.animations && settings.openingAnimation
}

export function serializeOpeningStartupFlag(
  settings: Pick<BrowserSettings, 'animations' | 'openingAnimation'>
): string {
  return `${OPENING_STARTUP_FLAG_PREFIX}${isOpeningAnimationEnabled(settings) ? '1' : '0'}`
}

export function serializeOpeningStartupVolumeFlag(
  settings: Pick<BrowserSettings, 'openingAnimationSoundVolume'>
): string {
  return `${OPENING_STARTUP_VOLUME_FLAG_PREFIX}${normalizeOpeningSoundVolume(settings.openingAnimationSoundVolume)}`
}

export function serializeOpeningHandledStartupFlag(openingHandledBySplash: boolean): string {
  return `${OPENING_STARTUP_HANDLED_FLAG_PREFIX}${openingHandledBySplash ? '1' : '0'}`
}

export function serializeOpeningStartupQuery(
  settings: Pick<BrowserSettings, 'animations' | 'openingAnimation' | 'openingAnimationSoundVolume'>,
  openingHandledBySplash = false
): Record<
  typeof OPENING_STARTUP_QUERY_PARAM | typeof OPENING_STARTUP_VOLUME_QUERY_PARAM | typeof OPENING_STARTUP_HANDLED_QUERY_PARAM,
  string
> {
  return {
    [OPENING_STARTUP_QUERY_PARAM]: isOpeningAnimationEnabled(settings) ? '1' : '0',
    [OPENING_STARTUP_VOLUME_QUERY_PARAM]: String(normalizeOpeningSoundVolume(settings.openingAnimationSoundVolume)),
    [OPENING_STARTUP_HANDLED_QUERY_PARAM]: openingHandledBySplash ? '1' : '0'
  }
}

export function parseOpeningStartupFlag(argv: readonly string[]): boolean {
  const flag = argv.find((value) => value.startsWith(OPENING_STARTUP_FLAG_PREFIX))
  if (!flag) return false
  return flag.slice(OPENING_STARTUP_FLAG_PREFIX.length) === '1'
}

export function parseOpeningHandledStartupFlag(argv: readonly string[]): boolean {
  const flag = argv.find((value) => value.startsWith(OPENING_STARTUP_HANDLED_FLAG_PREFIX))
  if (!flag) return false
  return flag.slice(OPENING_STARTUP_HANDLED_FLAG_PREFIX.length) === '1'
}

export function normalizeOpeningSoundVolume(value: number): number {
  if (!Number.isFinite(value)) return 85
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function parseOpeningStartupVolumeFlag(argv: readonly string[], fallback = 85): number {
  const flag = argv.find((value) => value.startsWith(OPENING_STARTUP_VOLUME_FLAG_PREFIX))
  if (!flag) return normalizeOpeningSoundVolume(fallback)
  return normalizeOpeningSoundVolume(Number(flag.slice(OPENING_STARTUP_VOLUME_FLAG_PREFIX.length)))
}

export function parseOpeningStartupSearch(search: string): boolean {
  return new URLSearchParams(search).get(OPENING_STARTUP_QUERY_PARAM) === '1'
}

export function parseOpeningHandledStartupSearch(search: string): boolean {
  return new URLSearchParams(search).get(OPENING_STARTUP_HANDLED_QUERY_PARAM) === '1'
}

export function parseOpeningStartupVolumeSearch(search: string, fallback = 85): number {
  const value = new URLSearchParams(search).get(OPENING_STARTUP_VOLUME_QUERY_PARAM)
  if (value === null) return normalizeOpeningSoundVolume(fallback)
  return normalizeOpeningSoundVolume(Number(value))
}
