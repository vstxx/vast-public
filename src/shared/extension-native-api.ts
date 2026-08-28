export const VAST_NATIVE_API_VERSION = 1 as const

export const VAST_NATIVE_PERMISSIONS = [
  'vast.storage',
  'vast.tabs.read',
  'vast.tabs.write',
  'vast.theme',
  'vast.toolbar',
  'vast.sidebar',
  'vast.commands',
  'vast.contextMenus',
  'vast.notifications'
] as const

export type VastNativePermission = typeof VAST_NATIVE_PERMISSIONS[number]
export type VastExtensionKind = 'chrome' | 'vast' | 'hybrid'
export type VastNativeRuntimeState = 'not-applicable' | 'pending-permission' | 'starting' | 'running' | 'stopped' | 'error'

export interface VastPermissionMetadata {
  id: VastNativePermission
  title: string
  description: string
  risk: 'low' | 'medium' | 'high'
}

export const VAST_PERMISSION_METADATA: Record<VastNativePermission, VastPermissionMetadata> = {
  'vast.storage': { id: 'vast.storage', title: 'Store data in Vast', description: 'Store extension data locally in Vast.', risk: 'low' },
  'vast.tabs.read': { id: 'vast.tabs.read', title: 'Read your open tabs', description: 'See the titles and addresses of normal web tabs.', risk: 'high' },
  'vast.tabs.write': { id: 'vast.tabs.write', title: 'Control normal web tabs', description: 'Create, navigate, reload, activate, and close normal web tabs.', risk: 'high' },
  'vast.theme': { id: 'vast.theme', title: "Change Vast's appearance", description: 'Apply a validated visual theme overlay.', risk: 'low' },
  'vast.toolbar': { id: 'vast.toolbar', title: 'Add buttons to the Vast toolbar', description: 'Add a limited number of native-looking toolbar actions.', risk: 'low' },
  'vast.sidebar': { id: 'vast.sidebar', title: 'Add panels to the Vast sidebar', description: 'Add sandboxed extension pages to the side panel.', risk: 'medium' },
  'vast.commands': { id: 'vast.commands', title: 'Add commands and shortcuts', description: 'Add clearly identified actions to the command palette.', risk: 'low' },
  'vast.contextMenus': { id: 'vast.contextMenus', title: 'Add actions to page menus', description: 'Add limited actions to normal webpage context menus.', risk: 'medium' },
  'vast.notifications': { id: 'vast.notifications', title: 'Show Vast notifications', description: 'Show bounded notifications inside Vast.', risk: 'low' }
}

export interface VastExtensionManifestSection {
  api_version: number
  extension_id?: string
  background?: string
  popup?: string
  options?: string
  permissions: VastNativePermission[]
}

export interface VastExtensionTab {
  id: string
  title: string
  url: string
  active: boolean
  workspaceId?: string
}

export interface VastTabQuery { active?: boolean; workspaceId?: string }
export interface VastTabCreateOptions { url: string; active?: boolean }
export interface VastTabUpdateOptions { url?: string; active?: boolean }

export interface VastThemeTokens {
  accentColor?: string
  secondaryAccentColor?: string
  backgroundTintColor?: string
  surfaceTintColor?: string
  cornerRadius?: number
  glassIntensity?: number
  blurIntensity?: number
  borderIntensity?: number
  shadowIntensity?: number
  gradientIntensity?: number
  panelOpacity?: number
  chromeOpacity?: number
  saturation?: number
}

export interface VastToolbarAction { id: string; title: string; icon?: string; enabled?: boolean; badge?: string }
export interface VastSidebarPanel { id: string; title: string; icon?: string; page: string }
export interface VastExtensionCommand { id: string; title: string; shortcut?: string }
export interface VastContextMenuItem { id: string; title: string }
export interface VastNotificationOptions { title: string; message: string }

export type VastNativeEventName =
  | 'toolbar.onClicked'
  | 'commands.onCommand'
  | 'contextMenus.onClicked'
  | 'tabs.onActivated'
  | 'tabs.onCreated'
  | 'tabs.onUpdated'
  | 'tabs.onRemoved'

export interface VastExtensionEvent<T> {
  addListener(callback: (value: T) => void): void
  removeListener(callback: (value: T) => void): void
}

export interface VastNativeExtensionApi {
  runtime: {
    getManifest(): Promise<Record<string, unknown>>
    getExtensionInfo(): Promise<{ id: string; name: string; version: string; apiVersion: number }>
    getPlatformInfo(): Promise<{ platform: string; vastVersion: string; chromiumVersion: string }>
  }
  storage: { local: {
    get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
    set(items: Record<string, unknown>): Promise<void>
    remove(keys: string | string[]): Promise<void>
    clear(): Promise<void>
  } }
  tabs: {
    query(query?: VastTabQuery): Promise<VastExtensionTab[]>
    get(id: string): Promise<VastExtensionTab | undefined>
    create(options: VastTabCreateOptions): Promise<VastExtensionTab>
    update(id: string, options: VastTabUpdateOptions): Promise<VastExtensionTab>
    reload(id: string): Promise<void>
    close(id: string): Promise<void>
    activate(id: string): Promise<void>
    onActivated: VastExtensionEvent<VastExtensionTab>
    onCreated: VastExtensionEvent<VastExtensionTab>
    onUpdated: VastExtensionEvent<VastExtensionTab>
    onRemoved: VastExtensionEvent<{ id: string }>
  }
  theme: { apply(tokens: VastThemeTokens): Promise<void>; clear(): Promise<void> }
  toolbar: {
    create(action: VastToolbarAction): Promise<VastToolbarAction>
    update(id: string, patch: Partial<Omit<VastToolbarAction, 'id'>>): Promise<VastToolbarAction>
    remove(id: string): Promise<void>
    onClicked: VastExtensionEvent<{ id: string }>
  }
  sidebar: { create(panel: VastSidebarPanel): Promise<VastSidebarPanel>; remove(id: string): Promise<void> }
  commands: {
    register(command: VastExtensionCommand): Promise<VastExtensionCommand & { shortcutAccepted: boolean; warning?: string }>
    remove(id: string): Promise<void>
    onCommand: VastExtensionEvent<{ id: string }>
  }
  contextMenus: {
    create(item: VastContextMenuItem): Promise<VastContextMenuItem>
    remove(id: string): Promise<void>
    onClicked: VastExtensionEvent<{ menuItemId: string; tabId?: string; selectionText?: string; linkUrl?: string; pageUrl?: string }>
  }
  notifications: { create(options: VastNotificationOptions): Promise<void> }
}

export interface VastExtensionContributionSnapshot {
  revision: number
  theme?: { extensionId: string; tokens: VastThemeTokens }
  toolbar: Array<VastToolbarAction & { extensionId: string; extensionName: string; key: string }>
  sidebar: Array<VastSidebarPanel & { extensionId: string; extensionName: string; key: string; resourceUrl: string }>
  commands: Array<VastExtensionCommand & { extensionId: string; extensionName: string; key: string; shortcutAccepted: boolean }>
  contextMenus: Array<VastContextMenuItem & { extensionId: string; extensionName: string; key: string }>
}

export type VastUiBrokerOperation =
  | 'tabs.query' | 'tabs.get' | 'tabs.create' | 'tabs.update' | 'tabs.reload' | 'tabs.close' | 'tabs.activate'

export interface VastUiBrokerRequest { requestId: string; operation: VastUiBrokerOperation; args: unknown[] }
export interface VastUiBrokerResponse { requestId: string; ok: boolean; result?: unknown; error?: string }
