export interface ShortcutParts {
  key: string
  ctrlOrMeta: boolean
  shift: boolean
  alt: boolean
}

export function parseShortcut(shortcut: string): ShortcutParts | null {
  const tokens = shortcut
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.length === 0) return null
  const key = tokens.at(-1)
  if (!key) return null
  return {
    key: normalizeShortcutKey(key),
    ctrlOrMeta: tokens.includes('ctrl/cmd') || tokens.includes('cmd/ctrl') || tokens.includes('control') || tokens.includes('ctrl') || tokens.includes('cmd') || tokens.includes('meta'),
    shift: tokens.includes('shift'),
    alt: tokens.includes('alt') || tokens.includes('option')
  }
}

export function normalizeShortcutKey(key: string): string {
  const normalized = key.toLowerCase()
  if (normalized === 'plus') return '+'
  if (normalized === 'minus') return '-'
  if (normalized === 'left') return 'arrowleft'
  if (normalized === 'right') return 'arrowright'
  if (normalized === 'space') return ' '
  return normalized
}
