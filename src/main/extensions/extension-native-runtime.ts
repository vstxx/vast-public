import { BrowserWindow, app, ipcMain, session, type WebContents } from 'electron/main'
import { join } from 'node:path'
import type { VastNativeEventName, VastNativeRuntimeState } from '../../shared/extension-native-api.ts'
import type { InstalledExtensionRecord, ValidatedExtensionManifest } from './extension-types.ts'
import { ExtensionResourceProtocol } from './extension-resource-protocol.ts'
import { ExtensionCapabilityBroker, type NativeExtensionAuthority } from './extension-capability-broker.ts'

interface Host { window: BrowserWindow; record: InstalledExtensionRecord; manifest: ValidatedExtensionManifest; intentionalStop: boolean }

export class ExtensionNativeRuntime {
  private hosts = new Map<string, Host>()
  private senders = new Map<number, string>()
  private surfaces = new Map<number, { id: string; record: InstalledExtensionRecord; manifest: ValidatedExtensionManifest }>()
  private registered = false
  private shuttingDown = false

  constructor(
    private readonly resources: ExtensionResourceProtocol,
    private readonly broker: ExtensionCapabilityBroker,
    private readonly stateChanged: (id: string, state: VastNativeRuntimeState, error?: string) => void
  ) {}

  registerIpc(): void {
    if (this.registered) return
    this.registered = true
    ipcMain.handle('vast-native:call', async (event, method: unknown, args: unknown) => this.broker.call(event.sender, method, args))
  }

  authorityFor(sender: WebContents): NativeExtensionAuthority | undefined {
    const surface = this.surfaces.get(sender.id)
    if (surface) return { record: surface.record, manifest: surface.manifest, sender }
    const id = this.senders.get(sender.id); if (!id) return undefined
    const host = this.hosts.get(id)
    return host && host.window.webContents.id === sender.id ? { record: host.record, manifest: host.manifest, sender } : undefined
  }

  async prepareSurfaceSession(partition: string, id: string, manifest: ValidatedExtensionManifest): Promise<void> {
    const target = session.fromPartition(partition, { cache: false })
    await this.resources.register(target)
    this.resources.set(id, manifest)
    target.setPermissionCheckHandler(() => false)
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    target.webRequest.onBeforeRequest((details, callback) => {
      try { const url = new URL(details.url); callback({ cancel: url.protocol !== 'vast-extension:' || url.hostname !== id }) } catch { callback({ cancel: true }) }
    })
  }

  bindSurface(contents: WebContents, record: InstalledExtensionRecord, manifest: ValidatedExtensionManifest): void {
    this.surfaces.set(contents.id, { id: record.id, record, manifest })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      try { const target = new URL(url); if (target.protocol !== 'vast-extension:' || target.hostname !== record.id) event.preventDefault() } catch { event.preventDefault() }
    })
    contents.once('destroyed', () => this.surfaces.delete(contents.id))
  }

  async start(record: InstalledExtensionRecord, manifest: ValidatedExtensionManifest): Promise<void> {
    if (this.shuttingDown || !manifest.vast?.background) return
    await this.stop(record.id)
    this.stateChanged(record.id, 'starting')
    const targetSession = session.fromPartition(`vast-native-extension-${record.id}`, { cache: false })
    await targetSession.clearStorageData().catch(() => undefined)
    await targetSession.clearCache().catch(() => undefined)
    await this.resources.register(targetSession)
    this.resources.set(record.id, manifest)
    targetSession.setPermissionCheckHandler(() => false)
    targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    targetSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url)
        callback({ cancel: url.protocol !== 'vast-extension:' || url.hostname !== record.id })
      } catch { callback({ cancel: true }) }
    })
    const window = new BrowserWindow({
      show: false, skipTaskbar: true, frame: false, width: 1, height: 1,
      webPreferences: {
        preload: join(app.getAppPath(), 'out', 'preload', 'extension-host.js'), partition: `vast-native-extension-${record.id}`,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, nodeIntegrationInWorker: false,
        experimentalFeatures: false, spellcheck: false, backgroundThrottling: false
      }
    })
    window.setSkipTaskbar(true)
    const host: Host = { window, record, manifest, intentionalStop: false }
    this.hosts.set(record.id, host); this.senders.set(window.webContents.id, record.id)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (url !== `vast-extension://${record.id}/__vast_background__.html`) event.preventDefault() })
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', (_event, details) => this.failed(record.id, `Extension runtime stopped (${details.reason}).`))
    window.webContents.once('destroyed', () => { if (!host.intentionalStop) this.failed(record.id, 'Extension runtime was destroyed.') })
    try {
      await window.loadURL(`vast-extension://${record.id}/__vast_background__.html`)
      if (this.hosts.get(record.id) === host && !window.isDestroyed()) this.stateChanged(record.id, 'running')
    } catch (error) {
      await this.stop(record.id)
      const message = error instanceof Error ? error.message : String(error)
      this.stateChanged(record.id, 'error', message.slice(0, 512))
    }
  }

  private failed(id: string, error: string): void {
    const host = this.hosts.get(id); if (!host || host.intentionalStop) return
    this.hosts.delete(id); this.senders.delete(host.window.webContents.id); this.resources.remove(id)
    this.stateChanged(id, 'error', error)
  }

  async stop(id: string): Promise<void> {
    const host = this.hosts.get(id)
    if (host) {
      host.intentionalStop = true; this.hosts.delete(id); this.senders.delete(host.window.webContents.id)
      if (!host.window.isDestroyed()) host.window.destroy()
    }
    this.resources.remove(id); this.broker.cleanup(id)
    for (const [senderId, surface] of [...this.surfaces]) if (surface.id === id) this.surfaces.delete(senderId)
  }

  updateAuthority(record: InstalledExtensionRecord, manifest: ValidatedExtensionManifest): void {
    const host = this.hosts.get(record.id); if (host) { host.record = record; host.manifest = manifest; this.resources.set(record.id, manifest) }
    for (const surface of this.surfaces.values()) if (surface.id === record.id) { surface.record = record; surface.manifest = manifest }
  }

  send(id: string, name: VastNativeEventName, payload: unknown): void {
    const host = this.hosts.get(id); if (host) this.broker.sendEvent(host.window.webContents, name, payload)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.all([...this.hosts.keys()].map((id) => this.stop(id)))
  }
}
