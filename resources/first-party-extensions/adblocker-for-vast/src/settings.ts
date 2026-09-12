import { normalizeAdblockHost } from './hosts.ts'
export const LISTS = [
  { id: 'easylist', name: 'EasyList', category: 'ads', url: 'https://easylist.to/easylist/easylist.txt', default: true },
  { id: 'easyprivacy', name: 'EasyPrivacy', category: 'trackers', url: 'https://easylist.to/easylist/easyprivacy.txt', default: true },
  { id: 'ublock', name: 'uBlock Origin filters', category: 'ads', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt', default: false },
  { id: 'cookies', name: 'EasyList cookie notices', category: 'annoyances', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', default: false }
]
export interface Settings { schema: 1; enabled: boolean; blockAds: boolean; blockTrackers: boolean; cosmetics: boolean; autoUpdate: boolean; lists: string[]; allowlist: string[]; cosmeticAllowlist: string[]; customFilters: string }
export function defaults(): Settings { return { schema: 1, enabled: true, blockAds: true, blockTrackers: true, cosmetics: true, autoUpdate: true, lists: ['easylist', 'easyprivacy'], allowlist: [], cosmeticAllowlist: [], customFilters: '' } }
export function validateSettings(input: unknown): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.')
  const value = input as Settings, result = defaults()
  if (value.schema !== 1) throw new Error('Unsupported settings version.')
  for (const key of ['enabled', 'blockAds', 'blockTrackers', 'cosmetics', 'autoUpdate'] as const) {
    if (typeof value[key] !== 'boolean') throw new Error('Invalid setting.'); result[key] = value[key]
  }
  for (const key of ['allowlist', 'cosmeticAllowlist'] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 1000) throw new Error('At most 1,000 sites are supported.')
    result[key] = [...new Set(value[key].map(host => { const normalized = normalizeAdblockHost(host); if (!normalized) throw new Error('Enter a hostname without scheme, path or port.'); return normalized }))]
  }
  if (!Array.isArray(value.lists) || value.lists.length > LISTS.length || value.lists.some(id => !LISTS.some(list => list.id === id))) throw new Error('Unknown filter list.')
  result.lists = [...new Set(value.lists)]
  if (typeof value.customFilters !== 'string' || new TextEncoder().encode(value.customFilters).length > 65536) throw new Error('Custom filters exceed 64 KiB.')
  result.customFilters = value.customFilters
  return result
}
