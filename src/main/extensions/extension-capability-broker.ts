import { app, type WebContents } from 'electron/main'
import type { InstalledExtensionRecord, ValidatedExtensionManifest } from './extension-types.ts'
import type { VastExtensionTab, VastNativeEventName, VastNativePermission } from '../../shared/extension-native-api.ts'
import { ExtensionStorage } from './extension-storage.ts'
import { ExtensionContributionRegistry } from './extension-contributions.ts'
import { ExtensionUiBroker } from './extension-ui-broker.ts'
import { showRendererNotification } from '../ui-bridge.ts'

export interface NativeExtensionAuthority { record: InstalledExtensionRecord; manifest: ValidatedExtensionManifest; sender: WebContents }

const METHOD_PERMISSION: Record<string, VastNativePermission | undefined> = {
  'storage.local.get': 'vast.storage', 'storage.local.set': 'vast.storage', 'storage.local.remove': 'vast.storage', 'storage.local.clear': 'vast.storage',
  'tabs.query': 'vast.tabs.read', 'tabs.get': 'vast.tabs.read', 'tabs.create': 'vast.tabs.write', 'tabs.update': 'vast.tabs.write', 'tabs.reload': 'vast.tabs.write', 'tabs.close': 'vast.tabs.write', 'tabs.activate': 'vast.tabs.write',
  'theme.apply': 'vast.theme', 'theme.clear': 'vast.theme', 'toolbar.create': 'vast.toolbar', 'toolbar.update': 'vast.toolbar', 'toolbar.remove': 'vast.toolbar',
  'sidebar.create': 'vast.sidebar', 'sidebar.remove': 'vast.sidebar', 'commands.register': 'vast.commands', 'commands.remove': 'vast.commands',
  'contextMenus.create': 'vast.contextMenus', 'contextMenus.remove': 'vast.contextMenus', 'notifications.create': 'vast.notifications'
}

const SAFE_TAB_URL = /^https?:\/\//i
const RESERVED_SHORTCUTS = new Set(['CTRL+L', 'CTRL+T', 'CTRL+W', 'CMD+L', 'CMD+T', 'CMD+W', 'CTRL+SHIFT+P', 'CMD+SHIFT+P'])

function argsArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid extension API arguments.')
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new Error('Extension API arguments must be serializable.') }
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new Error('Extension API arguments are too large.')
  return value
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096 || !SAFE_TAB_URL.test(value)) throw new Error('Only http and https URLs are allowed.')
  const url = new URL(value)
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.')
  return url.toString()
}

function tab(value: unknown): VastExtensionTab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser returned an invalid tab.')
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || input.id.length > 128 || typeof input.title !== 'string' || input.title.length > 512 || typeof input.url !== 'string' || !SAFE_TAB_URL.test(input.url) || typeof input.active !== 'boolean') throw new Error('Browser returned an invalid tab.')
  return { id: input.id, title: input.title, url: safeUrl(input.url), active: input.active, ...(typeof input.workspaceId === 'string' && input.workspaceId.length <= 128 ? { workspaceId: input.workspaceId } : {}) }
}

export class ExtensionCapabilityBroker {
  private calls = new Map<string, number>()
  private notifications = new Map<string, number[]>()

  constructor(
    private readonly authorityFor: (sender: WebContents) => NativeExtensionAuthority | undefined,
    private readonly storage: ExtensionStorage,
    private readonly contributions: ExtensionContributionRegistry,
    private readonly ui: ExtensionUiBroker
  ) {}

  async call(sender: WebContents, methodValue: unknown, argsValue: unknown): Promise<unknown> {
    const authority = this.authorityFor(sender)
    if (!authority || authority.sender.id !== sender.id || sender.isDestroyed()) throw new Error('Unauthorized extension host.')
    const method = typeof methodValue === 'string' && methodValue.length <= 80 ? methodValue : ''
    const args = argsArray(argsValue)
    const permission = METHOD_PERMISSION[method]
    if (!method.startsWith('runtime.') && !permission) throw new Error('Unknown Vast extension API method.')
    if (permission && (!authority.manifest.vast?.permissions.includes(permission) || !authority.record.grantedPermissions.includes(permission))) throw new Error(`Permission denied: ${permission}`)
    const active = this.calls.get(authority.record.id) ?? 0
    if (active >= 32) throw new Error('Too many concurrent extension API calls.')
    this.calls.set(authority.record.id, active + 1)
    try { return await this.execute(authority, method, args) } finally {
      const next = (this.calls.get(authority.record.id) ?? 1) - 1
      if (next > 0) this.calls.set(authority.record.id, next); else this.calls.delete(authority.record.id)
    }
  }

  private async execute(authority: NativeExtensionAuthority, method: string, args: unknown[]): Promise<unknown> {
    const { record, manifest } = authority; const id = record.id
    if (method === 'runtime.getManifest') return structuredClone(manifest.manifest)
    if (method === 'runtime.getExtensionInfo') return { id, name: record.name, version: record.version, apiVersion: manifest.vast?.api_version ?? 0 }
    if (method === 'runtime.getPlatformInfo') return { platform: process.platform, vastVersion: app.getVersion(), chromiumVersion: process.versions.chrome }
    if (method === 'storage.local.get') return this.storage.get(id, args[0])
    if (method === 'storage.local.set') return this.storage.set(id, args[0])
    if (method === 'storage.local.remove') return this.storage.remove(id, args[0])
    if (method === 'storage.local.clear') return this.storage.clear(id)
    if (method === 'theme.apply') return this.contributions.applyTheme(id, args[0])
    if (method === 'theme.clear') return this.contributions.clearTheme(id)
    if (method === 'toolbar.create') return this.contributions.createToolbar(id, args[0])
    if (method === 'toolbar.update') return this.contributions.updateToolbar(id, args[0], args[1])
    if (method === 'toolbar.remove') return this.contributions.removeToolbar(id, args[0])
    if (method === 'sidebar.create') return this.contributions.createSidebar(id, args[0])
    if (method === 'sidebar.remove') return this.contributions.removeSidebar(id, args[0])
    if (method === 'commands.register') {
      const shortcut = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>).shortcut : undefined
      const accepted = typeof shortcut !== 'string' || !RESERVED_SHORTCUTS.has(shortcut.trim().toUpperCase().replace(/\s/g, ''))
      const command = this.contributions.registerCommand(id, args[0], accepted)
      return { ...command, ...(!accepted ? { warning: 'The requested shortcut is reserved by Vast.' } : {}) }
    }
    if (method === 'commands.remove') return this.contributions.removeCommand(id, args[0])
    if (method === 'contextMenus.create') return this.contributions.createContextMenu(id, args[0])
    if (method === 'contextMenus.remove') return this.contributions.removeContextMenu(id, args[0])
    if (method === 'notifications.create') return this.notify(authority, args[0])
    if (method.startsWith('tabs.')) return this.tabs(method, args)
    throw new Error('Unknown Vast extension API method.')
  }

  private async tabs(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'tabs.create') {
      if (!args[0] || typeof args[0] !== 'object') throw new Error('Invalid tab options.')
      const source = args[0] as Record<string, unknown>; args = [{ url: safeUrl(source.url), active: source.active !== false }]
    } else if (method === 'tabs.update') {
      if (typeof args[0] !== 'string' || !args[1] || typeof args[1] !== 'object') throw new Error('Invalid tab update.')
      const source = args[1] as Record<string, unknown>; args = [args[0], { ...(source.url === undefined ? {} : { url: safeUrl(source.url) }), ...(source.active === undefined ? {} : { active: source.active === true }) }]
    } else if (method !== 'tabs.query' && (typeof args[0] !== 'string' || args[0].length > 128)) throw new Error('Invalid tab ID.')
    const result = await this.ui.request(method as Parameters<ExtensionUiBroker['request']>[0], args)
    if (method === 'tabs.query') {
      if (!Array.isArray(result) || result.length > 1_000) throw new Error('Browser returned invalid tabs.')
      return result.map(tab)
    }
    if (method === 'tabs.get' || method === 'tabs.create' || method === 'tabs.update') return result === undefined ? undefined : tab(result)
    return undefined
  }

  private notify(authority: NativeExtensionAuthority, input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid notification.')
    const source = input as Record<string, unknown>
    if (typeof source.title !== 'string' || !source.title.trim() || source.title.length > 100 || typeof source.message !== 'string' || !source.message.trim() || source.message.length > 1_000) throw new Error('Invalid notification.')
    const now = Date.now(); const recent = (this.notifications.get(authority.record.id) ?? []).filter((time) => time > now - 60_000)
    if (recent.length >= 10) throw new Error('Notification rate limit exceeded.')
    recent.push(now); this.notifications.set(authority.record.id, recent)
    showRendererNotification(undefined, { tone: 'info', title: source.title.trim(), message: source.message.trim() })
  }

  sendEvent(sender: WebContents, name: VastNativeEventName, payload: unknown): void { if (!sender.isDestroyed()) sender.send('vast-native:event', name, payload) }
  cleanup(id: string): void { this.calls.delete(id); this.notifications.delete(id) }
}
