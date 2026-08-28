import type { VastContextMenuItem, VastExtensionCommand, VastExtensionContributionSnapshot, VastSidebarPanel, VastThemeTokens, VastToolbarAction } from '../../shared/extension-native-api.ts'

const CONTRIBUTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
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
  const allowed = new Set(['accentColor', 'secondaryAccentColor', 'backgroundTintColor', 'surfaceTintColor', 'cornerRadius', 'glassIntensity', 'blurIntensity', 'borderIntensity', 'shadowIntensity', 'gradientIntensity', 'panelOpacity', 'chromeOpacity', 'saturation'])
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new Error('Theme contains an unsupported token.')
  const result: VastThemeTokens = {}
  for (const key of ['accentColor', 'secondaryAccentColor', 'backgroundTintColor', 'surfaceTintColor'] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string' || !COLOR.test(source[key] as string)) throw new Error(`Invalid theme token ${key}.`)
      result[key] = source[key] as string
    }
  }
  const ranges: Record<string, [number, number]> = { cornerRadius: [6, 36], saturation: [80, 145] }
  for (const key of ['cornerRadius', 'glassIntensity', 'blurIntensity', 'borderIntensity', 'shadowIntensity', 'gradientIntensity', 'panelOpacity', 'chromeOpacity', 'saturation'] as const) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'number' || !Number.isFinite(source[key])) throw new Error(`Invalid theme token ${key}.`)
    const [min, max] = ranges[key] ?? [0, 100]
    result[key] = Math.min(max, Math.max(min, source[key]))
  }
  return result
}

export class ExtensionContributionRegistry {
  private readonly extensionName: (id: string) => string
  private readonly changed: (snapshot: VastExtensionContributionSnapshot) => void
  private revision = 0
  private activationSequence = 0
  private themes = new Map<string, { tokens: VastThemeTokens; sequence: number }>()
  private toolbar = new Map<string, VastToolbarAction>()
  private sidebar = new Map<string, VastSidebarPanel>()
  private commands = new Map<string, VastExtensionCommand & { shortcutAccepted: boolean }>()
  private contextMenus = new Map<string, VastContextMenuItem>()

  constructor(extensionName: (id: string) => string, changed: (snapshot: VastExtensionContributionSnapshot) => void) { this.extensionName = extensionName; this.changed = changed }
  private key(extensionId: string, localId: string): string { return `${extensionId}:${localId}` }
  private emit(): void { this.revision += 1; this.changed(this.snapshot()) }

  applyTheme(extensionId: string, input: unknown): void { this.themes.set(extensionId, { tokens: validateTheme(input), sequence: ++this.activationSequence }); this.emit() }
  clearTheme(extensionId: string): void { if (this.themes.delete(extensionId)) this.emit() }

  createToolbar(extensionId: string, input: unknown): VastToolbarAction {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid toolbar action.')
    if ([...this.toolbar.keys()].filter((key) => key.startsWith(`${extensionId}:`)).length >= 5) throw new Error('Toolbar action limit reached (5).')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const action: VastToolbarAction = { id: localId, title: text(source.title, 'toolbar title', 80), ...(optionalResource(source.icon, 'toolbar icon') ? { icon: optionalResource(source.icon, 'toolbar icon') } : {}), enabled: source.enabled === undefined ? true : source.enabled === true }
    if (source.badge !== undefined) action.badge = text(source.badge, 'toolbar badge', 8)
    this.toolbar.set(this.key(extensionId, localId), action); this.emit(); return { ...action }
  }
  updateToolbar(extensionId: string, localIdInput: unknown, patch: unknown): VastToolbarAction {
    const localId = id(localIdInput); const key = this.key(extensionId, localId); const existing = this.toolbar.get(key)
    if (!existing || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Toolbar action does not exist.')
    const source = patch as Record<string, unknown>; const next = { ...existing }
    if (source.title !== undefined) next.title = text(source.title, 'toolbar title', 80)
    if (source.icon !== undefined) next.icon = optionalResource(source.icon, 'toolbar icon')
    if (source.enabled !== undefined) { if (typeof source.enabled !== 'boolean') throw new Error('Invalid toolbar enabled state.'); next.enabled = source.enabled }
    if (source.badge !== undefined) next.badge = text(source.badge, 'toolbar badge', 8)
    this.toolbar.set(key, next); this.emit(); return { ...next }
  }
  removeToolbar(extensionId: string, localId: unknown): void { if (this.toolbar.delete(this.key(extensionId, id(localId)))) this.emit() }

  createSidebar(extensionId: string, input: unknown): VastSidebarPanel {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid sidebar panel.')
    if ([...this.sidebar.keys()].filter((key) => key.startsWith(`${extensionId}:`)).length >= 5) throw new Error('Sidebar panel limit reached (5).')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const panel: VastSidebarPanel = { id: localId, title: text(source.title, 'sidebar title', 80), page: resourcePath(source.page, 'sidebar page'), ...(optionalResource(source.icon, 'sidebar icon') ? { icon: optionalResource(source.icon, 'sidebar icon') } : {}) }
    this.sidebar.set(this.key(extensionId, localId), panel); this.emit(); return { ...panel }
  }
  removeSidebar(extensionId: string, localId: unknown): void { if (this.sidebar.delete(this.key(extensionId, id(localId)))) this.emit() }

  registerCommand(extensionId: string, input: unknown, shortcutAccepted: boolean): VastExtensionCommand & { shortcutAccepted: boolean } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid command.')
    if ([...this.commands.keys()].filter((key) => key.startsWith(`${extensionId}:`)).length >= 50) throw new Error('Command limit reached (50).')
    const source = input as Record<string, unknown>; const localId = id(source.id)
    const command = { id: localId, title: text(source.title, 'command title', 100), ...(source.shortcut === undefined ? {} : { shortcut: text(source.shortcut, 'command shortcut', 64) }), shortcutAccepted }
    this.commands.set(this.key(extensionId, localId), command); this.emit(); return { ...command }
  }
  removeCommand(extensionId: string, localId: unknown): void { if (this.commands.delete(this.key(extensionId, id(localId)))) this.emit() }

  createContextMenu(extensionId: string, input: unknown): VastContextMenuItem {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid context menu item.')
    if ([...this.contextMenus.keys()].filter((key) => key.startsWith(`${extensionId}:`)).length >= 50) throw new Error('Context menu item limit reached (50).')
    const source = input as Record<string, unknown>; const localId = id(source.id); const item = { id: localId, title: text(source.title, 'context menu title', 100) }
    this.contextMenus.set(this.key(extensionId, localId), item); this.emit(); return { ...item }
  }
  removeContextMenu(extensionId: string, localId: unknown): void { if (this.contextMenus.delete(this.key(extensionId, id(localId)))) this.emit() }

  removePermission(extensionId: string, permission: string): void {
    let changed = false; const prefix = `${extensionId}:`
    const clear = (map: Map<string, unknown>): void => { for (const key of [...map.keys()]) if (key.startsWith(prefix)) { map.delete(key); changed = true } }
    if (permission === 'vast.theme' && this.themes.delete(extensionId)) changed = true
    if (permission === 'vast.toolbar') clear(this.toolbar)
    if (permission === 'vast.sidebar') clear(this.sidebar)
    if (permission === 'vast.commands') clear(this.commands)
    if (permission === 'vast.contextMenus') clear(this.contextMenus)
    if (changed) this.emit()
  }

  removeExtension(extensionId: string): void {
    let changed = this.themes.delete(extensionId); const prefix = `${extensionId}:`
    for (const map of [this.toolbar, this.sidebar, this.commands, this.contextMenus]) for (const key of [...map.keys()]) if (key.startsWith(prefix)) { map.delete(key); changed = true }
    if (changed) this.emit()
  }

  ownerFor(key: string): { extensionId: string; type: 'toolbar' | 'sidebar' | 'commands' | 'contextMenus'; localId: string } | undefined {
    const separator = key.indexOf(':'); if (separator < 1) return undefined
    const extensionId = key.slice(0, separator); const localId = key.slice(separator + 1)
    if (this.toolbar.has(key)) return { extensionId, type: 'toolbar', localId }
    if (this.sidebar.has(key)) return { extensionId, type: 'sidebar', localId }
    if (this.commands.has(key)) return { extensionId, type: 'commands', localId }
    if (this.contextMenus.has(key)) return { extensionId, type: 'contextMenus', localId }
    return undefined
  }

  snapshot(): VastExtensionContributionSnapshot {
    const name = (extensionId: string) => this.extensionName(extensionId)
    const rows = <T extends { id: string }>(map: Map<string, T>) => [...map.entries()].map(([key, value]) => ({ ...value, key, extensionId: key.slice(0, key.indexOf(':')), extensionName: name(key.slice(0, key.indexOf(':'))) }))
    const theme = [...this.themes.entries()].sort((a, b) => b[1].sequence - a[1].sequence)[0]
    return { revision: this.revision, ...(theme ? { theme: { extensionId: theme[0], tokens: { ...theme[1].tokens } } } : {}), toolbar: rows(this.toolbar), sidebar: rows(this.sidebar).map((panel) => ({ ...panel, resourceUrl: `vast-extension://${panel.extensionId}/${panel.page}` })), commands: rows(this.commands), contextMenus: rows(this.contextMenus) }
  }
}
