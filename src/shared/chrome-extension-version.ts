/** Chrome manifest versions contain one to four dot-separated numeric parts. */
export const CHROME_EXTENSION_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/

function parts(version: string): number[] {
  if (!CHROME_EXTENSION_VERSION.test(version)) throw new Error('Chrome extension version is invalid.')
  const result = version.split('.').map(Number)
  if (result.some((part) => !Number.isSafeInteger(part) || part > 65535)) throw new Error('Chrome extension version component is invalid.')
  return result
}

export function isNewerChromeExtensionVersion(candidate: string, installed: string): boolean {
  const next = parts(candidate)
  const previous = parts(installed)
  for (let index = 0; index < 4; index += 1) {
    const difference = (next[index] ?? 0) - (previous[index] ?? 0)
    if (difference) return difference > 0
  }
  return false
}

export function isChromeExtensionVersion(value: string): boolean {
  try { parts(value); return true } catch { return false }
}
