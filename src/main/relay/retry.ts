const MIN_PERIODIC_MS = 5.5 * 60 * 60 * 1_000
const PERIODIC_JITTER_RANGE_MS = 60 * 60 * 1_000
const RETRY_BASE_MS = [60_000, 5 * 60_000, 20 * 60_000] as const
const MIN_RATE_LIMIT_MS = 5 * 60_000
const MAX_RATE_LIMIT_MS = 6 * 60 * 60 * 1_000

export const RELAY_MAX_RETRIES = RETRY_BASE_MS.length

function unit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(0.999999, Math.max(0, value))
}

export function relayPeriodicDelay(randomValue = Math.random()): number {
  return Math.round(MIN_PERIODIC_MS + unit(randomValue) * PERIODIC_JITTER_RANGE_MS)
}

export function relayRetryDelay(retryIndex: number, randomValue = Math.random()): number | null {
  const base = RETRY_BASE_MS[retryIndex]
  if (base === undefined) return null
  const factor = 0.8 + unit(randomValue) * 0.4
  return Math.round(base * factor)
}

export function relayRetryAfterDelay(value: string | null, now = Date.now()): number {
  let requested = MIN_RATE_LIMIT_MS
  if (value && /^\d{1,8}$/.test(value.trim())) {
    requested = Number(value.trim()) * 1_000
  } else if (value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) requested = parsed - now
  }
  return Math.min(MAX_RATE_LIMIT_MS, Math.max(MIN_RATE_LIMIT_MS, requested))
}

export function relayHttpFailureIsTransient(status: number): boolean {
  return status === 408 || status === 425 || status >= 500
}
