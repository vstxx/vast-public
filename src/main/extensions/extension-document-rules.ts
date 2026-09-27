import { isAuthSensitiveUrl } from '../../shared/auth-compatibility-policy.ts'

export const DOCUMENT_RULE_TTL = 15_000
export const DOCUMENT_RULE_MAX_BYTES = 512 * 1024
export function documentRuleUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384) return
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isAuthSensitiveUrl(url.href)) return
    return url.href
  } catch { return }
}
export function sanitizeDocumentRules(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const scripts = (value as { scripts?: unknown }).scripts
  if (!Array.isArray(scripts) || scripts.length > 128 || scripts.some(script => typeof script !== 'string' || script.includes('\0'))) return
  if (scripts.reduce((size, script) => size + Buffer.byteLength(script), 0) > DOCUMENT_RULE_MAX_BYTES) return
  return [...new Set(scripts)]
}
/** Only the network coordinator stages rules. There is no renderer write API. */
export function createDocumentRuleStore(now = Date.now) {
  type Entry = { generation: number; url: string; expires: number; rules: Map<number, string[]> }
  const entries = new Map<number, Entry>()
  let sequence = 0
  return {
    begin(guest: number, url: string) {
      for (const [id, entry] of entries) if (entry.expires < now()) entries.delete(id)
      if (entries.size >= 256) entries.delete(entries.keys().next().value!)
      const generation = ++sequence
      entries.set(guest, { generation, url, expires: now() + DOCUMENT_RULE_TTL, rules: new Map() })
      return generation
    },
    stage(guest: number, generation: number, url: string, provider: number, scripts: string[]) {
      const entry = entries.get(guest)
      if (!entry || entry.generation !== generation || entry.url !== url || entry.expires < now()) return false
      if (entry.rules.size >= 8) return false
      entry.rules.set(provider, scripts); return true
    },
    take(guest: number, url: string, authorized: (provider: number) => boolean) {
      const entry = entries.get(guest)
      // A stale caller cannot consume the next navigation's rules.
      if (!entry || entry.url !== url || entry.expires < now()) return []
      entries.delete(guest)
      const scripts = [...entry.rules].filter(([provider]) => authorized(provider)).flatMap(([, rules]) => rules)
      return sanitizeDocumentRules({ scripts }) ?? []
    },
    navigationStarted(guest: number, url: string) {
      const entry = entries.get(guest)
      if (entry && (entry.url !== documentRuleUrl(url) || entry.expires < now())) entries.delete(guest)
    },
    invalidateGuest(guest: number) { entries.delete(guest) },
    invalidateProvider(provider: number) { for (const entry of entries.values()) entry.rules.delete(provider) }
  }
}
