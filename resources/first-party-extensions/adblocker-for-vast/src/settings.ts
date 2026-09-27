import { normalizeAdblockHost } from './hosts.ts'
const daily = 86_400_000
// Source trust is code-owned. Neither settings nor downloaded text can set it.
export const LISTS = Object.freeze([
  { id: 'easylist', name: 'EasyList', category: 'ads', label: 'Recommended', url: 'https://easylist.to/easylist/easylist.txt', default: true, cadence: daily, trusted: false },
  { id: 'easyprivacy', name: 'EasyPrivacy', category: 'trackers', label: 'Recommended', url: 'https://easylist.to/easylist/easyprivacy.txt', default: true, cadence: daily, trusted: false },
  { id: 'ublock', name: 'uBlock Origin filters', category: 'ads', label: 'Recommended', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt', default: true, cadence: daily, trusted: true },
  { id: 'quick-fixes', name: 'uBlock Quick fixes', category: 'ads', label: 'Rapid fixes · every 6 hours', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt', default: true, cadence: daily / 4, trusted: true },
  { id: 'unbreak', name: 'uBlock Unbreak', category: 'compatibility', label: 'Compatibility', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt', default: true, cadence: daily, trusted: true },
  { id: 'ublock-privacy', name: 'uBlock Privacy', category: 'trackers', label: 'Privacy', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt', default: true, cadence: daily, trusted: true },
  { id: 'cookies', name: 'EasyList cookie notices', category: 'annoyances', label: 'Optional', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', default: false, cadence: daily, trusted: false }
].map(list => Object.freeze(list)))
export interface Settings { schema: 2; enabled: boolean; blockAds: boolean; blockTrackers: boolean; cosmetics: boolean; advancedProtection: boolean; autoUpdate: boolean; lists: string[]; allowlist: string[]; cosmeticAllowlist: string[]; advancedAllowlist: string[]; customFilters: string }
export function defaults(): Settings { return { schema: 2, enabled: true, blockAds: true, blockTrackers: true, cosmetics: true, advancedProtection: true, autoUpdate: true, lists: LISTS.filter(list => list.default).map(list => list.id), allowlist: [], cosmeticAllowlist: [], advancedAllowlist: [], customFilters: '' } }
export function migrateSettings(input: unknown): Settings {
  if (input && typeof input === 'object' && 'schema' in input && input.schema === 1) {
    // Preserve explicit selections, including deliberately disabled lists.
    return validateSettings({ ...input, schema: 2, advancedProtection: true, advancedAllowlist: [] })
  }
  return validateSettings(input)
}
export function validateSettings(input: unknown): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.')
  const value = input as Settings, result = defaults()
  if (value.schema !== 2) throw new Error('Unsupported settings version.')
  for (const key of ['enabled', 'blockAds', 'blockTrackers', 'cosmetics', 'advancedProtection', 'autoUpdate'] as const) {
    if (typeof value[key] !== 'boolean') throw new Error('Invalid setting.'); result[key] = value[key]
  }
  for (const key of ['allowlist', 'cosmeticAllowlist', 'advancedAllowlist'] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 1000) throw new Error('At most 1,000 sites are supported.')
    result[key] = [...new Set(value[key].map(host => { const normalized = normalizeAdblockHost(host); if (!normalized) throw new Error('Enter a hostname without scheme, path or port.'); return normalized }))]
  }
  if (!Array.isArray(value.lists) || value.lists.length > LISTS.length || value.lists.some(id => !LISTS.some(list => list.id === id))) throw new Error('Unknown filter list.')
  result.lists = [...new Set(value.lists)]
  if (typeof value.customFilters !== 'string' || new TextEncoder().encode(value.customFilters).length > 65536) throw new Error('Custom filters exceed 64 KiB.')
  result.customFilters = value.customFilters
  return result
}
