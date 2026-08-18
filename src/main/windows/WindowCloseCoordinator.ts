import { dialog, type BrowserWindow, type WebContents } from 'electron/main'
import { randomUUID } from 'node:crypto'

interface PendingClose {
  window: BrowserWindow
  finish: (result: { ok: boolean; error?: string }) => void
}

const CLOSE_FLUSH_TIMEOUT_MS = 5_000

/** Main-owned close barrier that waits for renderer persistence completion. */
export class WindowCloseCoordinator {
  private readonly pending = new Map<string, PendingClose>()
  private readonly installed = new Set<number>()

  install(window: BrowserWindow): void {
    if (this.installed.has(window.id)) return
    this.installed.add(window.id)
    let closing = false

    window.on('close', (event) => {
      if (closing || window.isDestroyed()) return
      event.preventDefault()
      closing = true
      void this.closeAfterFlush(window).finally(() => {
        if (!window.isDestroyed()) closing = false
      })
    })
    window.once('closed', () => {
      this.installed.delete(window.id)
      for (const [requestId, request] of this.pending) {
        if (request.window === window) {
          this.pending.delete(requestId)
          request.finish({ ok: false, error: 'Window closed before persistence completed.' })
        }
      }
    })
  }

  resolve(sender: WebContents, requestId: string, result: { ok: boolean; error?: string }): boolean {
    const request = this.pending.get(requestId)
    if (!request || request.window.webContents !== sender) return false
    this.pending.delete(requestId)
    request.finish(result)
    return true
  }

  private async requestFlush(window: BrowserWindow): Promise<{ ok: boolean; error?: string }> {
    if (window.webContents.isDestroyed()) return { ok: false, error: 'Renderer is unavailable.' }
    const requestId = randomUUID()
    const result = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ ok: false, error: 'Timed out while saving final window state.' })
      }, CLOSE_FLUSH_TIMEOUT_MS)
      this.pending.set(requestId, {
        window,
        finish: (value) => {
          clearTimeout(timer)
          resolve(value)
        }
      })
    })
    window.webContents.send('vast:window:prepare-close', requestId)
    return result
  }

  private async closeAfterFlush(window: BrowserWindow): Promise<void> {
    while (!window.isDestroyed()) {
      const result = await this.requestFlush(window)
      if (result.ok) {
        window.destroy()
        return
      }

      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Vast could not finish saving',
        message: 'Vast could not confirm that the latest window state was saved.',
        detail: result.error ?? 'Unknown persistence error.',
        buttons: ['Retry save', 'Close without saving', 'Cancel close'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      if (choice.response === 0) continue
      if (choice.response === 1) window.destroy()
      return
    }
  }
}

export const windowCloseCoordinator = new WindowCloseCoordinator()
