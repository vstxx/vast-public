import { BrowserWindow, type WebContents } from 'electron/main'

export type VastWindowKind = 'primary' | 'normal' | 'detached' | 'popup' | 'auxiliary'

interface WindowRecord {
  window: BrowserWindow
  kind: VastWindowKind
  rendererReady: boolean
}

function hostWebContents(contents: WebContents): WebContents | undefined {
  return (contents as WebContents & { hostWebContents?: WebContents }).hostWebContents
}

/** Owns window identity without making global services close over one window. */
export class WindowRegistry {
  private readonly records = new Map<number, WindowRecord>()

  register(window: BrowserWindow, kind: VastWindowKind): void {
    const id = window.id
    this.records.set(id, { window, kind, rendererReady: false })
    window.once('closed', () => this.records.delete(id))
  }

  markRendererReady(window: BrowserWindow): void {
    const record = this.records.get(window.id)
    if (record) record.rendererReady = true
  }

  isRendererReady(window: BrowserWindow): boolean {
    return this.records.get(window.id)?.rendererReady === true
  }

  kindOf(window: BrowserWindow): VastWindowKind | undefined {
    return this.records.get(window.id)?.kind
  }

  ownerForWebContents(contents?: WebContents): BrowserWindow | undefined {
    if (!contents || contents.isDestroyed()) return undefined
    const host = hostWebContents(contents)
    const candidate = BrowserWindow.fromWebContents(host && !host.isDestroyed() ? host : contents)
    return candidate && !candidate.isDestroyed() ? candidate : undefined
  }

  vastWindowForWebContents(contents?: WebContents): BrowserWindow | undefined {
    const owner = this.ownerForWebContents(contents)
    if (!owner) return undefined
    const kind = this.kindOf(owner)
    if (kind === 'primary' || kind === 'normal' || kind === 'detached') return owner
    if (kind === 'popup') {
      const parent = owner.getParentWindow()
      const parentKind = parent ? this.kindOf(parent) : undefined
      if (parent && (parentKind === 'primary' || parentKind === 'normal' || parentKind === 'detached')) return parent
    }
    return undefined
  }

  focusedVastWindow(): BrowserWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && this.vastWindows().includes(focused)) return focused
    return this.vastWindows().find((window) => this.kindOf(window) === 'primary') ?? this.vastWindows()[0]
  }

  vastWindows(): BrowserWindow[] {
    return [...this.records.values()]
      .filter((record) => record.kind === 'primary' || record.kind === 'normal' || record.kind === 'detached')
      .map((record) => record.window)
      .filter((window) => !window.isDestroyed())
  }

  reattachTargetAt(point: { x: number; y: number }, source: BrowserWindow): BrowserWindow | undefined {
    const sourceBounds = source.getBounds()
    const pointIsInsideSource = point.x >= sourceBounds.x && point.x < sourceBounds.x + sourceBounds.width &&
      point.y >= sourceBounds.y && point.y < sourceBounds.y + sourceBounds.height
    if (pointIsInsideSource) return undefined

    return this.vastWindows()
      .filter((window) => window !== source && this.kindOf(window) !== 'detached' && window.isVisible() && !window.isMinimized())
      .find((window) => {
        const bounds = window.getBounds()
        return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
      })
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const window of this.vastWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(channel, ...args)
    }
  }
}

export const windowRegistry = new WindowRegistry()
