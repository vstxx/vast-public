import type { LayoutMode } from './types'

export type CatAnimationId =
  | 'omnibox-peek'
  | 'paw-swat'
  | 'tab-run'
  | 'tab-tail'
  | 'tab-climb'
  | 'closing-tab-paw'
  | 'new-tab-reaction'
  | 'toolbar-patrol'
  | 'edge-zoomies'
  | 'tab-nap'
  | 'sidebar-sneak'
  | 'bookmark-paw'
  | 'idle-cat'
  | 'secret-meow'
  | 'secret-pspsps'
  | 'secret-smile'
  | 'secret-vast-cat'

export function catAmbientSceneOrder(
  layoutMode: LayoutMode,
  bookmarkBarVisible: boolean
): readonly CatAnimationId[] {
  const shared: CatAnimationId[] = ['edge-zoomies', 'toolbar-patrol', 'omnibox-peek', 'tab-tail']
  if (layoutMode === 'vertical') return [...shared, 'sidebar-sneak', 'tab-climb']
  return [...shared, 'tab-run', 'tab-nap', ...(bookmarkBarVisible ? ['bookmark-paw' as const] : [])]
}

export interface ActiveCatAnimation {
  id: CatAnimationId
  startedAt: number
  durationMs: number
  reducedMotion: boolean
}

interface CatSchedulerClock {
  now: () => number
  random: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface CatAnimationSchedulerOptions {
  clock?: Partial<CatSchedulerClock>
  eligible?: () => boolean
  onAnimationChanged?: (animation: ActiveCatAnimation | null) => void
  startupQuietMs?: number
  globalCooldownMs?: number
  interactionCooldownMs?: number
}

const durations: Record<CatAnimationId, number> = {
  'omnibox-peek': 2_400,
  'paw-swat': 3_000,
  'tab-run': 5_800,
  'tab-tail': 1_700,
  'tab-climb': 6_200,
  'closing-tab-paw': 3_500,
  'new-tab-reaction': 2_300,
  'toolbar-patrol': 6_400,
  'edge-zoomies': 7_200,
  'tab-nap': 9_200,
  'sidebar-sneak': 4_800,
  'bookmark-paw': 3_200,
  'idle-cat': 14_000,
  'secret-meow': 3_600,
  'secret-pspsps': 4_200,
  'secret-smile': 2_600,
  'secret-vast-cat': 4_600
}

const cooldowns: Record<CatAnimationId, number> = {
  'omnibox-peek': 18_000,
  'paw-swat': 28_000,
  'tab-run': 24_000,
  'tab-tail': 16_000,
  'tab-climb': 90_000,
  'closing-tab-paw': 12_000,
  'new-tab-reaction': 12_000,
  'toolbar-patrol': 20_000,
  'edge-zoomies': 42_000,
  'tab-nap': 55_000,
  'sidebar-sneak': 24_000,
  'bookmark-paw': 16_000,
  'idle-cat': 70_000,
  'secret-meow': 1_200,
  'secret-pspsps': 1_200,
  'secret-smile': 1_200,
  'secret-vast-cat': 1_200
}

function productionClock(): CatSchedulerClock {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

function isSecret(id: CatAnimationId): boolean {
  return id.startsWith('secret-')
}

export class CatAnimationScheduler {
  private readonly clock: CatSchedulerClock
  private readonly eligible: () => boolean
  private readonly onAnimationChanged: (animation: ActiveCatAnimation | null) => void
  private readonly startedAt: number
  private readonly startupQuietMs: number
  private readonly globalCooldownMs: number
  private readonly interactionCooldownMs: number
  private readonly lastPlayedAt = new Map<CatAnimationId, number>()
  private lastOrdinaryAt = Number.NEGATIVE_INFINITY
  private active: ActiveCatAnimation | null = null
  private completionTimer: unknown
  private lastSecret = ''
  private lastOrdinaryId: CatAnimationId | undefined

  constructor(options: CatAnimationSchedulerOptions = {}) {
    const defaults = productionClock()
    this.clock = { ...defaults, ...options.clock }
    this.eligible = options.eligible ?? (() => true)
    this.onAnimationChanged = options.onAnimationChanged ?? (() => undefined)
    this.startedAt = this.clock.now()
    this.startupQuietMs = options.startupQuietMs ?? 45_000
    this.globalCooldownMs = options.globalCooldownMs ?? 60_000
    this.interactionCooldownMs = options.interactionCooldownMs ?? 4_500
  }

  getActive(): ActiveCatAnimation | null {
    return this.active ? { ...this.active } : null
  }

  request(
    id: CatAnimationId,
    options: { force?: boolean; interaction?: boolean; probability?: number; reducedMotion?: boolean; durationMs?: number } = {}
  ): boolean {
    if (!this.eligible()) return false
    if (this.active) {
      if (options.force === true) this.cancel()
      else return false
    }
    const now = this.clock.now()
    const forced = options.force === true
    const interaction = options.interaction === true
    if (!forced && !interaction && now - this.startedAt < this.startupQuietMs) return false
    const minimumGapMs = interaction ? Math.min(this.globalCooldownMs, this.interactionCooldownMs) : this.globalCooldownMs
    if (!forced && now - this.lastOrdinaryAt < minimumGapMs) return false
    if (!forced && !isSecret(id) && this.lastOrdinaryId === id) return false
    const lastPlayed = this.lastPlayedAt.get(id) ?? Number.NEGATIVE_INFINITY
    if (!forced && now - lastPlayed < cooldowns[id]) return false
    const probability = Math.max(0, Math.min(1, options.probability ?? 1))
    if (!forced && this.clock.random() > probability) return false
    const durationMs = options.reducedMotion
      ? Math.min(850, options.durationMs ?? durations[id])
      : options.durationMs ?? durations[id]
    this.active = { id, startedAt: now, durationMs, reducedMotion: options.reducedMotion === true }
    this.lastPlayedAt.set(id, now)
    if (!isSecret(id)) {
      this.lastOrdinaryAt = now
      this.lastOrdinaryId = id
    }
    this.onAnimationChanged({ ...this.active })
    this.completionTimer = this.clock.setTimeout(() => this.complete(id, now), durationMs)
    return true
  }

  requestSecret(phrase: string, id: Extract<CatAnimationId, `secret-${string}`>, reducedMotion = false): boolean {
    const normalized = phrase.trim().toLowerCase()
    if (!normalized || normalized === this.lastSecret) return false
    this.lastSecret = normalized
    return this.request(id, { force: true, reducedMotion })
  }

  clearSecret(): void {
    this.lastSecret = ''
  }

  cancel(predicate?: (animation: ActiveCatAnimation) => boolean): boolean {
    if (!this.active || predicate && !predicate(this.active)) return false
    if (this.completionTimer !== undefined) this.clock.clearTimeout(this.completionTimer)
    this.completionTimer = undefined
    this.active = null
    this.onAnimationChanged(null)
    return true
  }

  dispose(): void {
    this.cancel()
    this.lastPlayedAt.clear()
    this.lastSecret = ''
    this.lastOrdinaryId = undefined
  }

  private complete(id: CatAnimationId, startedAt: number): void {
    if (!this.active || this.active.id !== id || this.active.startedAt !== startedAt) return
    this.completionTimer = undefined
    this.active = null
    this.onAnimationChanged(null)
  }
}
