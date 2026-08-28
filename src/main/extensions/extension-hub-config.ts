export const PRODUCTION_EXTENSION_HUB_ORIGIN = 'https://extensions.vastbrowser.com'

export function extensionHubOrigin(isPackaged: boolean): string {
  const developmentOverride = !isPackaged ? process.env.VAST_EXTENSIONS_HUB_ORIGIN?.trim() : undefined
  if (!developmentOverride) return PRODUCTION_EXTENSION_HUB_ORIGIN
  const parsed = new URL(developmentOverride)
  if (parsed.username || parsed.password || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) throw new Error('Vast Extensions development origin is invalid.')
  if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('Insecure Vast Extensions origin is allowed only on localhost.')
  return parsed.origin
}
