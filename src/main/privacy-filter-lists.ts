import { net } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserSettings, PrivacyFilterStatus } from '../shared/types'
import { hostMatchesList, isThirdPartyUrl } from '../shared/url-cleaning'
import {
  emptyPrivacyFilterRules,
  parseNetworkFilterList,
  privacyFilterRulesAllow,
  privacyFilterRulesMatch,
  type PrivacyFilterRules
} from '../shared/privacy-filter-matcher'
import { vastDataPath } from './data-path'
import { atomicWriteFile } from './atomic-file'

type FilterCategory = 'ads' | 'trackers' | 'malware'
type FilterSourceId = 'easyList' | 'easyPrivacy' | 'peterLowe' | 'malware' | 'polishAnnoyances'

interface FilterSource {
  id: FilterSourceId
  url: string
  category: FilterCategory
  setting: keyof BrowserSettings['privacy']
}

interface CachedLists {
  version: 1
  updatedAt: number
  lists: Partial<Record<FilterSourceId, string>>
}

const FILTER_SOURCES: readonly FilterSource[] = [
  { id: 'easyList', url: 'https://easylist.to/easylist/easylist.txt', category: 'ads', setting: 'filterEasyList' },
  { id: 'easyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt', category: 'trackers', setting: 'filterEasyPrivacy' },
  { id: 'peterLowe', url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext', category: 'trackers', setting: 'filterPeterLowe' },
  { id: 'malware', url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains-online.txt', category: 'malware', setting: 'filterMalware' },
  { id: 'polishAnnoyances', url: 'https://raw.githubusercontent.com/FiltersHeroes/PolishAnnoyanceFilters/master/PPB.txt', category: 'ads', setting: 'filterPolishAnnoyances' }
]

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_LIST_BYTES = 12 * 1024 * 1024
const MAX_CACHE_BYTES = MAX_LIST_BYTES * FILTER_SOURCES.length * 2 + 2 * 1024 * 1024
const cacheFile = (): string => join(vastDataPath(), 'PrivacyFilters', 'filter-cache.json')

const parsedLists = new Map<FilterSourceId, PrivacyFilterRules>()
let cachedLists: CachedLists = { version: 1, updatedAt: 0, lists: {} }
let settingsProvider: (() => BrowserSettings) | undefined
let updating = false
let lastError: string | undefined
let initialized = false
let customText = ''
let customRules: PrivacyFilterRules = emptyPrivacyFilterRules()
const blockedSinceStart = { ads: 0, trackers: 0, malware: 0 }

function enabledCategories(settings: BrowserSettings): Record<FilterCategory, boolean> {
  if (settings.privacy.adBlockerMode !== 'custom') return {
    ads: settings.privacy.adBlockerEnabled,
    trackers: settings.privacy.blockTrackers,
    malware: settings.privacy.adBlockerEnabled
  }
  return {
    ads: settings.privacy.adBlockerEnabled && settings.privacy.customBlockAds,
    trackers: settings.privacy.customBlockTrackers,
    malware: settings.privacy.customBlockMalware
  }
}

export function matchPrivacyFilter(
  rawUrl: string,
  topLevelUrl: string | undefined,
  resourceType: string,
  settings: BrowserSettings
): FilterCategory | undefined {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return undefined
  } catch {
    return undefined
  }
  if (topLevelUrl && hostMatchesList(topLevelUrl, settings.privacy.adBlockAllowlist)) return undefined
  if (settings.privacy.customFilterRules !== customText) {
    customText = settings.privacy.customFilterRules
    customRules = parseNetworkFilterList(customText)
  }
  const matchContext = { topLevelUrl, resourceType }
  if (privacyFilterRulesAllow(customRules, rawUrl, matchContext)) return undefined
  if (privacyFilterRulesMatch(customRules, rawUrl, matchContext)) return 'ads'

  const categories = enabledCategories(settings)
  for (const source of FILTER_SOURCES) {
    if (!settings.privacy[source.setting] || !categories[source.category]) continue
    if (
      settings.privacy.adBlockerMode === 'standard' &&
      source.category !== 'malware' &&
      topLevelUrl &&
      !isThirdPartyUrl(rawUrl, topLevelUrl)
    ) continue
    if (resourceType === 'mainFrame' && source.category !== 'malware' && settings.privacy.adBlockerMode !== 'strict') continue
    const rules = parsedLists.get(source.id)
    if (rules && privacyFilterRulesMatch(rules, rawUrl, matchContext)) return source.category
  }
  return undefined
}

export function recordPrivacyFilterBlock(category: FilterCategory): void {
  blockedSinceStart[category] += 1
}

function applyCachedLists(cache: CachedLists): void {
  parsedLists.clear()
  for (const source of FILTER_SOURCES) {
    const text = cache.lists[source.id]
    if (text) parsedLists.set(source.id, parseNetworkFilterList(text))
  }
}

async function downloadFilter(source: FilterSource): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await net.fetch(source.url, {
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
      headers: { 'Cache-Control': 'no-cache' }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_LIST_BYTES) throw new Error('filter list is too large')
    if (!response.body) throw new Error('filter list response has no body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_LIST_BYTES) {
        await reader.cancel()
        throw new Error('filter list is too large')
      }
      chunks.push(chunk.value)
    }
    if (totalBytes === 0) throw new Error('filter list is empty')
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } finally {
    clearTimeout(timeout)
  }
}

async function persistCache(cache: CachedLists): Promise<void> {
  const target = cacheFile()
  await atomicWriteFile(target, `${JSON.stringify(cache)}\n`)
}

export async function updatePrivacyFilters(force = false): Promise<PrivacyFilterStatus> {
  if (updating) return privacyFilterStatus()
  const settings = settingsProvider?.()
  if (!settings) return privacyFilterStatus()
  const enabledSourceMissing = FILTER_SOURCES.some((source) => settings.privacy[source.setting] && !cachedLists.lists[source.id])
  if (!force && (!settings.privacy.filterAutoUpdate || !enabledSourceMissing && Date.now() - cachedLists.updatedAt < UPDATE_INTERVAL_MS)) return privacyFilterStatus()
  updating = true
  lastError = undefined
  try {
    const nextLists = { ...cachedLists.lists }
    const enabledSources = FILTER_SOURCES.filter((source) => settings.privacy[source.setting])
    const results = await Promise.allSettled(enabledSources.map(async (source) => ({ source, text: await downloadFilter(source) })))
    let successful = 0
    for (const result of results) {
      if (result.status === 'fulfilled') {
        nextLists[result.value.source.id] = result.value.text
        successful += 1
      }
    }
    if (successful === 0) throw new Error('No filter list could be updated; the previous cache remains active.')
    cachedLists = { version: 1, updatedAt: Date.now(), lists: nextLists }
    applyCachedLists(cachedLists)
    await persistCache(cachedLists)
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) lastError = `${failures.length} filter list${failures.length === 1 ? '' : 's'} could not be updated.`
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  } finally {
    updating = false
  }
  return privacyFilterStatus()
}

export function privacyFilterStatus(): PrivacyFilterStatus {
  const ruleCounts: Record<string, number> = {}
  for (const source of FILTER_SOURCES) {
    const rules = parsedLists.get(source.id)
    ruleCounts[source.id] = rules ? rules.blockedDomains.size + rules.blockedPatterns.length : 0
  }
  return {
    updating,
    lastUpdatedAt: cachedLists.updatedAt || undefined,
    nextUpdateAt: cachedLists.updatedAt ? cachedLists.updatedAt + UPDATE_INTERVAL_MS : undefined,
    ruleCounts,
    lastError,
    blockedSinceStart: { ...blockedSinceStart }
  }
}

export function initializePrivacyFilters(getSettings: () => BrowserSettings): void {
  settingsProvider = getSettings
  if (initialized) return
  initialized = true
  void stat(cacheFile())
    .then((info) => {
      if (info.size > MAX_CACHE_BYTES) throw new Error('filter cache is too large')
      return readFile(cacheFile(), 'utf8')
    })
    .then((text) => {
      const parsed = JSON.parse(text) as Partial<CachedLists>
      if (parsed.version !== 1 || !parsed.lists || typeof parsed.updatedAt !== 'number') return
      const lists: CachedLists['lists'] = {}
      for (const source of FILTER_SOURCES) {
        const value = parsed.lists[source.id]
        if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_LIST_BYTES) lists[source.id] = value
      }
      cachedLists = { version: 1, updatedAt: parsed.updatedAt, lists }
      applyCachedLists(cachedLists)
    })
    .catch(() => undefined)
    .finally(() => void updatePrivacyFilters(false))
  const timer = setInterval(() => void updatePrivacyFilters(false), 60 * 60 * 1000)
  timer.unref()
}
