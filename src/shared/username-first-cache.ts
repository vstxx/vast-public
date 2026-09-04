export interface UsernameFirstContext {
  windowId: number
  guestId: number
  origin: string
}

interface UsernameFirstEntry extends UsernameFirstContext {
  username: string
  observedAt: number
}

export class UsernameFirstCache {
  private readonly entries = new Map<string, UsernameFirstEntry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    ttlMs = 2 * 60_000,
    maxEntries = 64,
    now: () => number = Date.now
  ) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
  }

  observe(context: UsernameFirstContext, username: string, observedAt = this.now()): void {
    this.prune()
    const key = this.key(context)
    this.entries.delete(key)
    this.entries.set(key, { ...context, username, observedAt })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      this.entries.delete(oldest)
    }
  }

  lookup(context: UsernameFirstContext): string | undefined {
    this.prune()
    return this.entries.get(this.key(context))?.username
  }

  clearGuest(guestId: number): void {
    for (const [key, entry] of this.entries) if (entry.guestId === guestId) this.entries.delete(key)
  }

  clearWindow(windowId: number): void {
    for (const [key, entry] of this.entries) if (entry.windowId === windowId) this.entries.delete(key)
  }

  get size(): number {
    this.prune()
    return this.entries.size
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [key, entry] of this.entries) if (entry.observedAt < cutoff) this.entries.delete(key)
  }

  private key(context: UsernameFirstContext): string {
    return `${context.windowId}\u0000${context.guestId}\u0000${context.origin}`
  }
}
