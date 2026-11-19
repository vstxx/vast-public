import type { VastNativePermission } from './extension-native-api.ts'

// Declarative `vast.contributes`: static UI metadata registered from a
// validated manifest without running any extension code. Actions are a closed
// set; a manifest can never name a URL, script, IPC channel or host method.

export const VAST_CONTRIBUTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
export const VAST_CONTEXT_MENU_CONTEXTS = ['all', 'page', 'selection', 'link'] as const
export type VastContextMenuContext = typeof VAST_CONTEXT_MENU_CONTEXTS[number]

/** `popup` opens the extension's declared popup; `event` is delivered to its `vast.background`. */
export type VastDeclarativeAction = 'popup' | 'event'

export interface VastDeclaredToolbarAction { id: string; title: string; icon?: string; action: VastDeclarativeAction }
export interface VastDeclaredCommand { id: string; title: string; shortcut?: string; action: VastDeclarativeAction }
export interface VastDeclaredContextMenu { id: string; title: string; contexts: VastContextMenuContext[]; action: 'event' }
export interface VastDeclaredSidebarPanel { id: string; title: string; icon?: string; page: string }

export interface VastDeclarativeContributions {
  toolbar: VastDeclaredToolbarAction[]
  commands: VastDeclaredCommand[]
  context_menus: VastDeclaredContextMenu[]
  sidebar: VastDeclaredSidebarPanel[]
}

export const VAST_CONTRIBUTION_LIMITS = { toolbar: 5, sidebar: 5, commands: 50, context_menus: 50 } as const

const SECTION_PERMISSION: Record<keyof VastDeclarativeContributions, VastNativePermission> = {
  toolbar: 'vast.toolbar', commands: 'vast.commands', context_menus: 'vast.contextMenus', sidebar: 'vast.sidebar'
}
const ITEM_KEYS: Record<keyof VastDeclarativeContributions, readonly string[]> = {
  toolbar: ['id', 'title', 'icon', 'action'],
  commands: ['id', 'title', 'shortcut', 'action'],
  context_menus: ['id', 'title', 'contexts', 'action'],
  sidebar: ['id', 'title', 'icon', 'page']
}
const ICON_EXTENSION = /\.(?:png|svg|webp|jpe?g|gif|ico)$/i
const PAGE_EXTENSION = /\.html?$/i

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`vast.contributes has an invalid ${label}.`)
  return value.trim()
}

/** A local, relative package path; never absolute, a URL, or outside the package. */
export function contributionAssetPath(value: unknown, label: string, extension: RegExp): string {
  const path = text(value, label, 1_024)
  if (path.includes('\\') || path.startsWith('/') || path.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split('/').some((part) => part === '..' || part === '.' || !part) || !extension.test(path)) {
    throw new Error(`vast.contributes has an invalid ${label}.`)
  }
  return path
}

export function parseContextMenuContexts(value: unknown): VastContextMenuContext[] {
  if (value === undefined) return ['all']
  if (!Array.isArray(value) || value.length === 0 || value.length > VAST_CONTEXT_MENU_CONTEXTS.length) throw new Error('Invalid context menu contexts.')
  const contexts = [...new Set(value)]
  if (contexts.some((context) => !(VAST_CONTEXT_MENU_CONTEXTS as readonly unknown[]).includes(context))) throw new Error('Invalid context menu contexts.')
  return contexts as VastContextMenuContext[]
}

/** Chrome semantics: `page` applies only when the click has no more specific context. */
export function contextMenuApplies(contexts: readonly VastContextMenuContext[] | undefined, click: { selection: boolean; link: boolean }): boolean {
  if (!contexts || contexts.includes('all')) return true
  if (click.selection && contexts.includes('selection')) return true
  if (click.link && contexts.includes('link')) return true
  return !click.selection && !click.link && contexts.includes('page')
}

export function parseDeclarativeContributions(value: unknown, owner: { permissions: readonly VastNativePermission[]; hasBackground: boolean; hasPopup: boolean }): { contributions: VastDeclarativeContributions; assets: string[] } {
  if (!object(value)) throw new Error('vast.contributes must be an object.')
  const sections = Object.keys(SECTION_PERMISSION) as Array<keyof VastDeclarativeContributions>
  const unknownSection = Object.keys(value).find((key) => !(sections as string[]).includes(key))
  if (unknownSection) throw new Error(`vast.contributes.${unknownSection} is not supported.`)
  const contributions: VastDeclarativeContributions = { toolbar: [], commands: [], context_menus: [], sidebar: [] }
  const assets: string[] = []
  const action = (input: unknown, section: string): VastDeclarativeAction => {
    if (input === 'popup') {
      if (!owner.hasPopup) throw new Error(`vast.contributes.${section} uses action "popup" but the extension declares no popup.`)
      return input
    }
    if (input === 'event') {
      if (!owner.hasBackground) throw new Error(`vast.contributes.${section} uses action "event" but the extension declares no vast.background.`)
      return input
    }
    throw new Error(`vast.contributes.${section} has an unsupported action.`)
  }
  for (const section of sections) {
    const items = value[section]
    if (items === undefined) continue
    if (!Array.isArray(items) || items.length > VAST_CONTRIBUTION_LIMITS[section]) throw new Error(`vast.contributes.${section} is invalid or exceeds ${VAST_CONTRIBUTION_LIMITS[section]} entries.`)
    if (items.length > 0 && !owner.permissions.includes(SECTION_PERMISSION[section])) throw new Error(`vast.contributes.${section} requires the ${SECTION_PERMISSION[section]} permission.`)
    const seen = new Set<string>()
    for (const item of items) {
      if (!object(item) || Object.keys(item).some((key) => !ITEM_KEYS[section].includes(key))) throw new Error(`vast.contributes.${section} has an invalid entry.`)
      const id = text(item.id, `${section} ID`, 64)
      if (!VAST_CONTRIBUTION_ID.test(id) || seen.has(id)) throw new Error(`vast.contributes.${section} has an invalid or duplicate ID.`)
      seen.add(id)
      if (section === 'toolbar') {
        const icon = item.icon === undefined ? undefined : contributionAssetPath(item.icon, 'toolbar icon', ICON_EXTENSION)
        if (icon) assets.push(icon)
        contributions.toolbar.push({ id, title: text(item.title, 'toolbar title', 80), ...(icon ? { icon } : {}), action: action(item.action, section) })
      } else if (section === 'commands') {
        contributions.commands.push({ id, title: text(item.title, 'command title', 100), ...(item.shortcut === undefined ? {} : { shortcut: text(item.shortcut, 'command shortcut', 64) }), action: action(item.action, section) })
      } else if (section === 'context_menus') {
        if (item.action !== 'event') throw new Error('vast.contributes.context_menus entries must use action "event".')
        let contexts: VastContextMenuContext[]
        try { contexts = parseContextMenuContexts(item.contexts) } catch { throw new Error('vast.contributes.context_menus has invalid contexts.') }
        contributions.context_menus.push({ id, title: text(item.title, 'context menu title', 100), contexts, action: action(item.action, section) as 'event' })
      } else {
        const page = contributionAssetPath(item.page, 'side panel page', PAGE_EXTENSION)
        const icon = item.icon === undefined ? undefined : contributionAssetPath(item.icon, 'side panel icon', ICON_EXTENSION)
        assets.push(page, ...(icon ? [icon] : []))
        contributions.sidebar.push({ id, title: text(item.title, 'side panel title', 80), page, ...(icon ? { icon } : {}) })
      }
    }
  }
  return { contributions, assets }
}

export function contributionPermission(section: 'toolbar' | 'commands' | 'contextMenus' | 'sidebar'): VastNativePermission {
  return section === 'contextMenus' ? 'vast.contextMenus' : SECTION_PERMISSION[section]
}

export interface VastContextMenuClick { tabId?: string; pageUrl?: string; linkUrl?: string; selectionText?: string }

const TAB_ID = /^[A-Za-z0-9_-]{1,128}$/

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4_096 || !/^https?:\/\//i.test(value)) return undefined
  try { const url = new URL(value); return url.username || url.password ? undefined : url.toString() } catch { return undefined }
}

/**
 * The bounded click payload an extension receives. Items that declare
 * contexts only get the data those contexts concern; v1 items without
 * contexts keep receiving every field, as before.
 */
export function contextMenuClickPayload(input: unknown, contexts: readonly VastContextMenuContext[] | undefined): VastContextMenuClick {
  if (input === undefined) return {}
  if (!object(input) || Object.keys(input).some((key) => !['tabId', 'pageUrl', 'linkUrl', 'selectionText'].includes(key))) throw new Error('Invalid context menu click.')
  if ((input.tabId !== undefined && (typeof input.tabId !== 'string' || !TAB_ID.test(input.tabId))) || (input.selectionText !== undefined && typeof input.selectionText !== 'string')) throw new Error('Invalid context menu click.')
  const all = !contexts || contexts.includes('all')
  const pageUrl = webUrl(input.pageUrl)
  const linkUrl = all || contexts.includes('link') ? webUrl(input.linkUrl) : undefined
  const selectionText = (all || contexts.includes('selection')) && typeof input.selectionText === 'string' && input.selectionText ? input.selectionText.slice(0, 2_048) : undefined
  return { ...(typeof input.tabId === 'string' ? { tabId: input.tabId } : {}), ...(pageUrl ? { pageUrl } : {}), ...(linkUrl ? { linkUrl } : {}), ...(selectionText ? { selectionText } : {}) }
}
