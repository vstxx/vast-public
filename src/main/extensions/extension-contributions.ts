import type { VastContextMenuItem, VastContributionRow, VastExtensionCommand, VastExtensionContributionSnapshot, VastNativePermission, VastSidebarPanel, VastThemeTokens, VastToolbarAction } from '../../shared/extension-native-api.ts'
import { parseContextMenuContexts, VAST_CONTRIBUTION_ID as CONTRIBUTION_ID, VAST_CONTRIBUTION_LIMITS, type VastDeclarativeAction, type VastDeclarativeContributions } from '../../shared/extension-native-contributions.ts'
const COLOR = /^#[0-9a-f]{6}$/i

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}.`)
  const result = value.trim()
  if (!result || result.length > max) throw new Error(`Invalid ${label}.`)
  return result
}

function id(value: unknown): string {
  const result = text(value, 'contribution ID', 64)
  if (!CONTRIBUTION_ID.test(result)) throw new Error('Invalid contribution ID.')
  return result
}

function resourcePath(value: unknown, label: string): string {
  const result = text(value, label, 1_024).replace(/\\/g, '/')
  if (result.startsWith('/') || result.includes('\0') || result.split('/').includes('..') || /^[a-z]+:/i.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function optionalResource(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : resourcePath(value, label)
}

export function validateTheme(input: unknown): VastThemeTokens {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid theme tokens.')
  const source = input as Record<string, unknown>
  const allowed = new Set(['accentColor', 'secondaryAccentColor', 'backgroundTintColor', 'surfaceTintColor', 'cornerRadius', 'glassIntensity', 'blurIntensity', 'borderIntensity', 'shadowIntensity', 'gradientIntensity', 'panelOpacity', 'chromeOpacity', 'transparency', 'saturation'])
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new Error('Theme contains an unsupported token.')
  const result: VastThemeTokens = {}
  for (const key of ['accentColor', 'secondaryAccentColor', 'backgroundTintColor', 'surfaceTintColor'] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string' || !COLOR.test(source[key] as string)) throw new Error(`Invalid theme token ${key}.`)
      result[key] = source[key] as string
    }
  }
  const ranges: Record<string, [number, number]> = { cornerRadius: [6, 36], saturation: [80, 145] }
  for (const key of ['cornerRadius', 'glassIntensity', 'blurIntensity', 'borderIntensity', 'shadowIntensity', 'gradientIntensity', 'panelOpacity', 'chromeOpacity', 'transparency', 'saturation'] as const) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) throw new Error(`Invalid theme token ${key}.`)
    const [min, max] = ranges[key] ?? [0, 100]
    result[key] = Math.min(max, Math.max(min, source[key]))
  }
  return result
}

type ContributionType = 'toolbar' | 'sidebar' | 'commands' | 'contextMenus'
type Source = VastContributionRow['source']
interface Entry<T> { value: T; source: Source; action: VastDeclarativeAction; iconDataUrl?: string }

export interface ContributionOwner { extensionId: string; type: ContributionType; localId: string; source: Source; action: VastDeclarativeAction; contexts?: VastContextMenuItem['contexts'] }

const PERMISSION: Record<ContributionType, VastNativePermission> = { toolbar: 'vast.toolbar', sidebar: 'vast.sidebar', commands: 'vast.commands', contextMenus: 'vast.contextMenus' }

/**
 * One registry for both origins of UI contributions. Manifest entries are
 * registered by Vast from validated metadata and live as long as the
 * extension's Native layer is active; runtime entries are created by the
 * running background and disappear with it. Keys are `<extension id>:<local id>`
 * and a background cannot shadow or remove an ID its manifest declares.
 */
export class ExtensionContributionRegistry {
  private readonly extensionName: (id: string) => string
  private readonly changed: (snapshot: VastExtensionContributionSnapshot) => void
  private revision = 0
  private activationSequence = 0
  private themes = new Map<string, { tokens: VastThemeTokens; sequence: number }>()
  private toolbar = new Map<string, Entry<VastToolbarAction>>()
  private sidebar = new Map<string, Entry<VastSidebarPanel>>()
  private commands = new Map<string, Entry<VastExtensionCommand & { shortcutAccepted: boolean }>>()
  private contextMenus = new Map<string, Entry<VastContextMenuItem>>()
  private runningHosts = new Set<string>()
  private tabEvents = false

  constructor(extensionName: (id: string) => string, changed: (snapshot: VastExtensionContributionSnapshot) => void) { this.extensionName = extensionName; this.changed = changed }
  // Type-qualified so a toolbar action and a command may share a local ID.
  private key(extensionId: string, type: ContributionType, localId: string): string { return `${extensionId}:${type}:${localId}` }
  private emit(): void { this.revision += 1; this.changed(this.snapshot()) }
  private maps(): Array<[ContributionType, Map<string, Entry<unknown>>]> { return [['toolbar', this.toolbar], ['sidebar', this.sidebar], ['commands', this.commands], ['contextMenus', this.contextMenus]] }
  private count(map: Map<string, unknown>, extensionId: string): number { let total = 0; for (const key of map.keys()) if (key.startsWith(`${extensionId}:`)) total += 1; return total }
  private runtimeSlot<T>(map: Map<string, Entry<T>>, type: ContributionType, extensionId: string, localId: string, limit: number, label: string): string {
    const key = this.key(extensionId, type, localId); const existing = map.get(key)
    if (existing?.source === 'manifest') throw new Error(`The ${label} ID is declared in the extension manifest.`)
    if (!existing && this.count(map, extensionId) >= limit) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} limit reached (${limit}).`)
    return key
  }

  applyTheme(extensionId: string, input: unknown): void { this.themes.set(extensionId, { tokens: validateTheme(input), sequence: ++this.activationSequence }); this.emit() }
  clearTheme(extensionId: string): void { if (this.themes.delete(extensionId)) this.emit() }

  createToolbar(extensionId: string, input: unknown, iconDataUrl?: string): VastToolbarAction {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid toolbar action.')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const key = this.runtimeSlot(this.toolbar, 'toolbar', extensionId, localId, VAST_CONTRIBUTION_LIMITS.toolbar, 'toolbar action')
    const action: VastToolbarAction = { id: localId, title: text(source.title, 'toolbar title', 80), ...(optionalResource(source.icon, 'toolbar icon') ? { icon: optionalResource(source.icon, 'toolbar icon') } : {}), enabled: source.enabled === undefined ? true : source.enabled === true }
    if (source.badge !== undefined) action.badge = text(source.badge, 'toolbar badge', 8)
    this.toolbar.set(key, { value: action, source: 'runtime', action: 'event', ...(action.icon && iconDataUrl ? { iconDataUrl } : {}) }); this.emit(); return { ...action }
  }
  updateToolbar(extensionId: string, localIdInput: unknown, patch: unknown, iconDataUrl?: string): VastToolbarAction {
    const localId = id(localIdInput); const key = this.key(extensionId, 'toolbar', localId); const existing = this.toolbar.get(key)
    if (!existing || existing.source !== 'runtime' || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Toolbar action does not exist.')
    const source = patch as Record<string, unknown>; const next = { ...existing.value }; let nextIcon = existing.iconDataUrl
    if (source.title !== undefined) next.title = text(source.title, 'toolbar title', 80)
    if (source.icon !== undefined) { next.icon = optionalResource(source.icon, 'toolbar icon'); nextIcon = iconDataUrl }
    if (source.enabled !== undefined) { if (typeof source.enabled !== 'boolean') throw new Error('Invalid toolbar enabled state.'); next.enabled = source.enabled }
    if (source.badge !== undefined) next.badge = text(source.badge, 'toolbar badge', 8)
    const entry: Entry<VastToolbarAction> = { value: next, source: existing.source, action: existing.action }
    if (nextIcon) entry.iconDataUrl = nextIcon
    this.toolbar.set(key, entry); this.emit(); return { ...next }
  }
  removeToolbar(extensionId: string, localId: unknown): void { this.removeRuntimeEntry(this.toolbar, 'toolbar', extensionId, localId) }

  createSidebar(extensionId: string, input: unknown): VastSidebarPanel {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid side panel page.')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const key = this.runtimeSlot(this.sidebar, 'sidebar', extensionId, localId, VAST_CONTRIBUTION_LIMITS.sidebar, 'side panel')
    const panel: VastSidebarPanel = { id: localId, title: text(source.title, 'side panel title', 80), page: resourcePath(source.page, 'side panel page'), ...(optionalResource(source.icon, 'side panel icon') ? { icon: optionalResource(source.icon, 'side panel icon') } : {}) }
    this.sidebar.set(key, { value: panel, source: 'runtime', action: 'popup' }); this.emit(); return { ...panel }
  }
  removeSidebar(extensionId: string, localId: unknown): void { this.removeRuntimeEntry(this.sidebar, 'sidebar', extensionId, localId) }

  registerCommand(extensionId: string, input: unknown, shortcutAccepted: boolean): VastExtensionCommand & { shortcutAccepted: boolean } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid command.')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const key = this.runtimeSlot(this.commands, 'commands', extensionId, localId, VAST_CONTRIBUTION_LIMITS.commands, 'command')
    const command = { id: localId, title: text(source.title, 'command title', 100), ...(source.shortcut === undefined ? {} : { shortcut: text(source.shortcut, 'command shortcut', 64) }), shortcutAccepted }
    this.commands.set(key, { value: command, source: 'runtime', action: 'event' }); this.emit(); return { ...command }
  }
  removeCommand(extensionId: string, localId: unknown): void { this.removeRuntimeEntry(this.commands, 'commands', extensionId, localId) }

  createContextMenu(extensionId: string, input: unknown): VastContextMenuItem {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid context menu item.')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const key = this.runtimeSlot(this.contextMenus, 'contextMenus', extensionId, localId, VAST_CONTRIBUTION_LIMITS.context_menus, 'context menu item')
    // Items created without contexts keep the v1 behaviour: every page menu.
    const item: VastContextMenuItem = { id: localId, title: text(source.title, 'context menu title', 100), ...(source.contexts === undefined ? {} : { contexts: parseContextMenuContexts(source.contexts) }) }
    this.contextMenus.set(key, { value: item, source: 'runtime', action: 'event' }); this.emit(); return { ...item }
  }
  removeContextMenu(extensionId: string, localId: unknown): void { this.removeRuntimeEntry(this.contextMenus, 'contextMenus', extensionId, localId) }

  private removeRuntimeEntry(map: Map<string, Entry<unknown>>, type: ContributionType, extensionId: string, localIdInput: unknown): void {
    const key = this.key(extensionId, type, id(localIdInput)); const existing = map.get(key)
    if (existing?.source === 'manifest') throw new Error('Contributions declared in the extension manifest cannot be removed at runtime.')
    if (existing && map.delete(key)) this.emit()
  }

  /**
   * Replaces every manifest entry of one extension in a single update. Only
   * sections whose permission is currently granted are registered.
   */
  setDeclared(extensionId: string, declared: VastDeclarativeContributions | undefined, granted: readonly VastNativePermission[], icons: ReadonlyMap<string, string> = new Map()): void {
    const prefix = `${extensionId}:`
    for (const [, map] of this.maps()) for (const [key, entry] of [...map]) if (key.startsWith(prefix) && entry.source === 'manifest') map.delete(key)
    const allowed = (type: ContributionType): boolean => granted.includes(PERMISSION[type])
    if (declared && allowed('toolbar')) for (const item of declared.toolbar) {
      const icon = item.icon ? icons.get(item.icon) : undefined
      this.toolbar.set(this.key(extensionId, 'toolbar', item.id), { value: { id: item.id, title: item.title, ...(item.icon ? { icon: item.icon } : {}), enabled: true }, source: 'manifest', action: item.action, ...(icon ? { iconDataUrl: icon } : {}) })
    }
    // Manifest shortcuts are listed in the palette but not bound, like runtime ones.
    if (declared && allowed('commands')) for (const item of declared.commands) this.commands.set(this.key(extensionId, 'commands', item.id), { value: { id: item.id, title: item.title, ...(item.shortcut ? { shortcut: item.shortcut } : {}), shortcutAccepted: false }, source: 'manifest', action: item.action })
    if (declared && allowed('contextMenus')) for (const item of declared.context_menus) this.contextMenus.set(this.key(extensionId, 'contextMenus', item.id), { value: { id: item.id, title: item.title, contexts: [...item.contexts] }, source: 'manifest', action: item.action })
    if (declared && allowed('sidebar')) for (const item of declared.sidebar) this.sidebar.set(this.key(extensionId, 'sidebar', item.id), { value: { id: item.id, title: item.title, page: item.page, ...(item.icon ? { icon: item.icon } : {}) }, source: 'manifest', action: 'popup' })
    this.emit()
  }

  /** Event actions of an extension are executable only while its background runs. */
  setHostRunning(extensionId: string, running: boolean): void {
    if (running === this.runningHosts.has(extensionId)) return
    if (running) this.runningHosts.add(extensionId); else this.runningHosts.delete(extensionId)
    this.emit()
  }

  setTabEventDemand(wanted: boolean): void { if (wanted !== this.tabEvents) { this.tabEvents = wanted; this.emit() } }

  removePermission(extensionId: string, permission: string): void {
    let changed = false; const prefix = `${extensionId}:`
    if (permission === 'vast.theme' && this.themes.delete(extensionId)) changed = true
    for (const [type, map] of this.maps()) if (PERMISSION[type] === permission) for (const key of [...map.keys()]) if (key.startsWith(prefix)) { map.delete(key); changed = true }
    if (changed) this.emit()
  }

  /** The background stopped: drop what it registered, keep manifest entries. */
  removeRuntime(extensionId: string): void {
    let changed = this.themes.delete(extensionId); if (this.runningHosts.delete(extensionId)) changed = true
    const prefix = `${extensionId}:`
    for (const [, map] of this.maps()) for (const [key, entry] of [...map]) if (key.startsWith(prefix) && entry.source === 'runtime') { map.delete(key); changed = true }
    if (changed) this.emit()
  }

  removeExtension(extensionId: string): void {
    let changed = this.themes.delete(extensionId); if (this.runningHosts.delete(extensionId)) changed = true
    const prefix = `${extensionId}:`
    for (const [, map] of this.maps()) for (const key of [...map.keys()]) if (key.startsWith(prefix)) { map.delete(key); changed = true }
    if (changed) this.emit()
  }

  ownerFor(key: string): ContributionOwner | undefined {
    const [extensionId, keyType, localId] = key.split(':')
    if (!extensionId || !localId || key.split(':').length !== 3) return undefined
    for (const [type, map] of this.maps()) {
      const entry = type === keyType ? map.get(key) : undefined
      if (!entry) continue
      const contexts = type === 'contextMenus' ? (entry.value as VastContextMenuItem).contexts : undefined
      return { extensionId, type, localId, source: entry.source, action: entry.action, ...(contexts ? { contexts } : {}) }
    }
    return undefined
  }

  private available(extensionId: string, entry: Entry<unknown>): boolean {
    return entry.source === 'runtime' || entry.action === 'popup' || this.runningHosts.has(extensionId)
  }

  snapshot(): VastExtensionContributionSnapshot {
    const rows = <T extends { id: string }>(map: Map<string, Entry<T>>) => [...map.entries()].map(([key, entry]) => {
      const extensionId = key.slice(0, key.indexOf(':'))
      return { ...entry.value, ...(entry.iconDataUrl ? { iconDataUrl: entry.iconDataUrl } : {}), key, extensionId, extensionName: this.extensionName(extensionId), source: entry.source, action: entry.action, available: this.available(extensionId, entry) }
    })
    const theme = [...this.themes.entries()].sort((a, b) => b[1].sequence - a[1].sequence)[0]
    return {
      revision: this.revision,
      ...(theme ? { theme: { extensionId: theme[0], tokens: { ...theme[1].tokens } } } : {}),
      toolbar: rows(this.toolbar),
      sidebar: rows(this.sidebar).map((panel) => ({ ...panel, resourceUrl: `vast-extension://${panel.extensionId}/${panel.page}` })),
      commands: rows(this.commands),
      contextMenus: rows(this.contextMenus),
      nativeTabEvents: this.tabEvents
    }
  }
}
