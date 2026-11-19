// Every message between the extension's contexts. Each receiver validates shape and size before
// acting, and checks who sent it: a website can make a content script send almost anything, so the
// service worker treats content-script messages as untrusted input and the engine accepts requests
// from the service worker only.

import { isLanguageCode } from './catalog.ts'
import type { DisplayMode } from './settings.ts'

export const SCOPE = 'tfv'

export const LIMITS = Object.freeze({
  // One translation request: what a content script may ask the engine for in one round trip.
  fragments: 64,
  fragmentChars: 12_000,
  requestChars: 48_000,
  // Selected text; longer selections are cut, and the popup says so.
  selectionChars: 5_000,
  // Text sampled for language detection.
  sampleChars: 4_000
})

export type EnginePhase = 'uninitialized' | 'loading' | 'ready' | 'translating' | 'idle' | 'released' | 'error'

export interface DownloadProgress {
  pairKey: string
  loadedBytes: number
  totalBytes: number
  phase: 'download' | 'verify' | 'store' | 'done' | 'error' | 'cancelled'
  error?: string
}

export interface InstalledPair {
  pairKey: string
  source: string
  target: string
  version: string
  bytes: number
  installedAt: number
}

export interface RouteStatus {
  source: string
  target: string
  available: boolean
  pivot: boolean
  hops: Array<{ pairKey: string; installed: boolean; downloadBytes: number; diskBytes: number }>
  downloadBytes: number
  installed: boolean
}

export interface PageState {
  status: 'idle' | 'translating' | 'translated' | 'restoring' | 'error'
  source: string | null
  target: string | null
  done: number
  total: number
  error: string | null
  kept: number
}

// Content script -> service worker.
export type ContentRequest =
  | { scope: typeof SCOPE; type: 'content:translate'; source: string; target: string; fragments: string[]; priority: 'page' | 'selection' }
  | { scope: typeof SCOPE; type: 'content:detect'; sample: string; declared: string | null }
  | { scope: typeof SCOPE; type: 'content:route'; source: string; target: string }
  | { scope: typeof SCOPE; type: 'content:state'; state: PageState }
  | { scope: typeof SCOPE; type: 'content:cancel' }
  | { scope: typeof SCOPE; type: 'content:selection-request'; text: string }
  | { scope: typeof SCOPE; type: 'content:download'; source: string; target: string }
  | { scope: typeof SCOPE; type: 'content:auto-check'; declared: string | null; sample: string }
  | { scope: typeof SCOPE; type: 'content:open-options' }

// Service worker -> content script.
export type PageCommand =
  | { scope: typeof SCOPE; type: 'page:translate'; source: string; target: string; displayMode: DisplayMode }
  | { scope: typeof SCOPE; type: 'page:restore' }
  | { scope: typeof SCOPE; type: 'page:state' }
  | { scope: typeof SCOPE; type: 'page:selection'; text: string; target: string; targets: string[] }
  | { scope: typeof SCOPE; type: 'page:offer'; source: string; target: string; displayMode: DisplayMode; targets: string[] }

// Extension pages (popup, options) -> service worker.
export type UiRequest =
  | { scope: typeof SCOPE; type: 'ui:tab' }
  | { scope: typeof SCOPE; type: 'ui:translate'; tabId: number; source: string; target: string }
  | { scope: typeof SCOPE; type: 'ui:restore'; tabId: number }
  | { scope: typeof SCOPE; type: 'ui:route'; source: string; target: string }
  | { scope: typeof SCOPE; type: 'ui:download'; source: string; target: string }
  | { scope: typeof SCOPE; type: 'ui:cancel-download'; pairKey: string }
  | { scope: typeof SCOPE; type: 'ui:models' }
  | { scope: typeof SCOPE; type: 'ui:delete-model'; pairKey: string }
  | { scope: typeof SCOPE; type: 'ui:delete-all-models' }
  | { scope: typeof SCOPE; type: 'ui:engine-status' }
  | { scope: typeof SCOPE; type: 'ui:settings-changed' }

// Service worker -> engine (offscreen document).
export type EngineRequest =
  | { scope: typeof SCOPE; type: 'engine:translate'; source: string; target: string; fragments: string[]; priority: 'page' | 'selection'; tag: string }
  | { scope: typeof SCOPE; type: 'engine:cancel'; tag: string }
  | { scope: typeof SCOPE; type: 'engine:route'; source: string; target: string }
  | { scope: typeof SCOPE; type: 'engine:download'; source: string; target: string }
  | { scope: typeof SCOPE; type: 'engine:cancel-download'; pairKey: string }
  | { scope: typeof SCOPE; type: 'engine:models' }
  | { scope: typeof SCOPE; type: 'engine:delete-model'; pairKey: string }
  | { scope: typeof SCOPE; type: 'engine:delete-all-models' }
  | { scope: typeof SCOPE; type: 'engine:status' }
  | { scope: typeof SCOPE; type: 'engine:configure'; idleMs: number }

// Engine -> extension pages (broadcast).
export type EngineEvent =
  | { scope: typeof SCOPE; type: 'engine:progress'; progress: DownloadProgress }
  | { scope: typeof SCOPE; type: 'engine:phase'; phase: EnginePhase }

// A message type without its scope field, distributed over the union.
export type Unscoped<T> = T extends unknown ? Omit<T, 'scope'> : never

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function fragments(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.fragments) return false
  let total = 0
  for (const entry of value) {
    if (!boundedString(entry, LIMITS.fragmentChars)) return false
    total += entry.length
  }
  return total <= LIMITS.requestChars
}

function declared(value: unknown): boolean {
  return value === null || boundedString(value, 35)
}

export function parseContentRequest(value: unknown): ContentRequest | null {
  if (!object(value) || value.scope !== SCOPE) return null
  switch (value.type) {
    case 'content:translate':
      return isLanguageCode(value.source) && isLanguageCode(value.target) && value.source !== value.target && fragments(value.fragments) && (value.priority === 'page' || value.priority === 'selection')
        ? value as ContentRequest : null
    case 'content:detect':
    case 'content:auto-check':
      return boundedString(value.sample, LIMITS.sampleChars) && declared(value.declared) ? value as ContentRequest : null
    case 'content:route':
    case 'content:download':
      return isLanguageCode(value.source) && isLanguageCode(value.target) ? value as ContentRequest : null
    case 'content:state':
      return parsePageState(value.state) ? value as ContentRequest : null
    case 'content:selection-request':
      return boundedString(value.text, LIMITS.selectionChars * 4) ? value as ContentRequest : null
    case 'content:cancel':
    case 'content:open-options':
      return value as ContentRequest
    default:
      return null
  }
}

export function parsePageState(value: unknown): PageState | null {
  if (!object(value)) return null
  const statuses = ['idle', 'translating', 'translated', 'restoring', 'error']
  const count = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) >= 0 && (entry as number) < 10_000_000
  if (!statuses.includes(value.status as string) || !count(value.done) || !count(value.total) || !count(value.kept)) return null
  if (!(value.source === null || isLanguageCode(value.source)) || !(value.target === null || isLanguageCode(value.target))) return null
  if (!(value.error === null || boundedString(value.error, 500))) return null
  return value as unknown as PageState
}

export function parseUiRequest(value: unknown): UiRequest | null {
  if (!object(value) || value.scope !== SCOPE) return null
  const tab = Number.isSafeInteger(value.tabId) && (value.tabId as number) >= 0
  const pair = typeof value.pairKey === 'string' && /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[a-z]{2,3}(?:-[A-Z][a-z]{3})?$/.test(value.pairKey)
  const languages = isLanguageCode(value.source) && isLanguageCode(value.target) && value.source !== value.target
  switch (value.type) {
    case 'ui:tab':
    case 'ui:models':
    case 'ui:delete-all-models':
    case 'ui:engine-status':
    case 'ui:settings-changed':
      return value as UiRequest
    case 'ui:translate':
      return tab && languages ? value as UiRequest : null
    case 'ui:restore':
      return tab ? value as UiRequest : null
    case 'ui:route':
    case 'ui:download':
      return languages ? value as UiRequest : null
    case 'ui:cancel-download':
    case 'ui:delete-model':
      return pair ? value as UiRequest : null
    default:
      return null
  }
}

export function parsePageCommand(value: unknown): PageCommand | null {
  if (!object(value) || value.scope !== SCOPE) return null
  switch (value.type) {
    case 'page:translate':
      return isLanguageCode(value.source) && isLanguageCode(value.target) && (value.displayMode === 'replace' || value.displayMode === 'bilingual') ? value as PageCommand : null
    case 'page:restore':
    case 'page:state':
      return value as PageCommand
    case 'page:offer':
      return isLanguageCode(value.source) && isLanguageCode(value.target) && (value.displayMode === 'replace' || value.displayMode === 'bilingual') && Array.isArray(value.targets) && value.targets.every(isLanguageCode) ? value as PageCommand : null
    case 'page:selection':
      return boundedString(value.text, LIMITS.selectionChars) && isLanguageCode(value.target) && Array.isArray(value.targets) && value.targets.every(isLanguageCode) ? value as PageCommand : null
    default:
      return null
  }
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  return object(value) && value.scope === SCOPE && typeof value.type === 'string' && value.type.startsWith('engine:') && value.type !== 'engine:progress' && value.type !== 'engine:phase'
}

export function isEngineEvent(value: unknown): value is EngineEvent {
  return object(value) && value.scope === SCOPE && (value.type === 'engine:progress' || value.type === 'engine:phase')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
