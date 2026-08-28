import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron/main'
import type { VastUiBrokerOperation, VastUiBrokerRequest, VastUiBrokerResponse } from '../../shared/extension-native-api.ts'
import { windowRegistry } from '../windows/WindowRegistry.ts'

interface PendingRequest { ownerWebContentsId: number; resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }

export class ExtensionUiBroker {
  private pending = new Map<string, PendingRequest>()
  private accepting = true

  request(operation: VastUiBrokerOperation, args: unknown[], timeoutMs = 5_000): Promise<unknown> {
    if (!this.accepting) return Promise.reject(new Error('Vast is shutting down.'))
    const owner = windowRegistry.focusedVastWindow() ?? windowRegistry.vastWindows().find((window) => !window.isDestroyed())
    if (!owner) return Promise.reject(new Error('No Vast browser window is available.'))
    const request: VastUiBrokerRequest = { requestId: randomUUID(), operation, args }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(request.requestId); reject(new Error('Browser UI request timed out.')) }, timeoutMs)
      this.pending.set(request.requestId, { ownerWebContentsId: owner.webContents.id, resolve, reject, timeout })
      owner.webContents.send('vast:extensions:ui-request', request)
    })
  }

  respond(sender: WebContents, response: VastUiBrokerResponse): boolean {
    if (!response || typeof response.requestId !== 'string') return false
    const entry = this.pending.get(response.requestId)
    if (!entry || entry.ownerWebContentsId !== sender.id) return false
    clearTimeout(entry.timeout); this.pending.delete(response.requestId)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error(typeof response.error === 'string' ? response.error.slice(0, 512) : 'Browser UI request failed.'))
    return true
  }

  shutdown(): void {
    this.accepting = false
    for (const entry of this.pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('Vast is shutting down.')) }
    this.pending.clear()
  }
}
