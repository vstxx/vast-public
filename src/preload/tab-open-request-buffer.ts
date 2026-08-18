import type { BrowserTabOpenRequest } from '../shared/types'

export type BrowserTabOpenCallback = (request: BrowserTabOpenRequest) => void

export class TabOpenRequestBuffer {
  private readonly callbacks = new Set<BrowserTabOpenCallback>()
  private readonly pending: BrowserTabOpenRequest[] = []
  private readonly maxPending: number

  constructor(maxPending = 100) {
    this.maxPending = maxPending
  }

  receive(request: BrowserTabOpenRequest): void {
    if (this.callbacks.size === 0) {
      if (this.pending.length >= this.maxPending) this.pending.shift()
      this.pending.push(request)
      return
    }

    for (const callback of [...this.callbacks]) callback(request)
  }

  subscribe(callback: BrowserTabOpenCallback): () => void {
    this.callbacks.add(callback)
    if (this.pending.length > 0) {
      const queued = this.pending.splice(0)
      for (const request of queued) callback(request)
    }

    return () => {
      this.callbacks.delete(callback)
    }
  }

  pendingCount(): number {
    return this.pending.length
  }
}
