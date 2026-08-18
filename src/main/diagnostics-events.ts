import { app } from 'electron/main'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-file'

export type DiagnosticsEvent = {
  at: string
  category: 'renderer' | 'guest' | 'gpu' | 'child' | 'window'
  event: string
  details?: Record<string, string | number | boolean | null>
}

const MAX_EVENTS = 200
let events: DiagnosticsEvent[] = []
let loaded = false
let loadPromise: Promise<void> | undefined

function diagnosticsPath(): string {
  return join(app.getPath('userData'), 'diagnostics-events.json')
}

export function redactDiagnosticsText(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|code|password|access_token|refresh_token)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '[home]')
    .replace(/\/home\/[^/\s]+/gi, '[home]')
    .slice(0, 500)
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loadPromise ??= readFile(diagnosticsPath(), 'utf8')
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) events = parsed.slice(-MAX_EVENTS) as DiagnosticsEvent[]
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true
    })
  await loadPromise
}

export async function recordDiagnosticsEvent(
  category: DiagnosticsEvent['category'],
  event: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await ensureLoaded()
  const safeDetails = Object.fromEntries(
    Object.entries(details).slice(0, 20).map(([key, value]) => [
      key.slice(0, 80),
      typeof value === 'number' || typeof value === 'boolean' || value === null
        ? value
        : redactDiagnosticsText(value)
    ])
  )
  events.push({ at: new Date().toISOString(), category, event: redactDiagnosticsText(event), details: safeDetails })
  events = events.slice(-MAX_EVENTS)
  await atomicWriteJson(diagnosticsPath(), events).catch((error) => {
    console.warn('[diagnostics] Failed to persist local event:', redactDiagnosticsText(error))
  })
}

export async function recentDiagnosticsEvents(): Promise<DiagnosticsEvent[]> {
  await ensureLoaded()
  return events.map((item) => ({ ...item, details: item.details ? { ...item.details } : undefined }))
}
