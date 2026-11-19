import {
  Bookmark,
  Cookie,
  Command as CommandIcon,
  Copy,
  Database,
  FileText,
  Fingerprint,
  Gauge,
  Globe2,
  History,
  Link2Off,
  LockKeyhole,
  Moon,
  PanelRight,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Settings,
  Shield,
  SplitSquareHorizontal,
  Sparkles,
  Star,
  Trash2,
  Wifi,
  X
} from 'lucide-react'
import { useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { focusWhenReady, PresenceContext, useMotionRef } from '../../lib/motion'
import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_EXTENSIONS_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_SESSION_TIMELINE_URL
} from '../../../shared/constants'
import { getFeatureState, VastFeatures, type FeatureId, type FeatureState } from '../../../shared/feature-gates'
import type { BrowserSettings, Command } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatRelativeTime } from '../../lib/format'
import { looksLikeUrl, paletteUrlKey, parsePaletteQuery, preparePaletteItem, scorePaletteItem, type PaletteScope } from '../../lib/palette-search'
import { getSearchEngine } from '../../lib/url'
import { deleteHistory } from '../../lib/history-actions'
import { useBrowserStore } from '../../store/browser-store'
import { VideoAudioMark } from '../avidae/VideoAudioBrand'
import { Favicon } from '../ui/Favicon'
import { useVastConfirm } from '../ui/useVastConfirm'
import { confirmClearAllHistory } from '../../lib/history-actions'
import { useExtensionContributions } from '../../extensions/extension-runtime'

type PaletteCommand = Command & {
  featureId?: FeatureId
  featureState?: FeatureState
  // Relevance added to a matching item: open tabs, frequently visited pages.
  boost?: number
}

type PaletteKind = 'tab' | 'bookmark' | 'history' | 'note' | 'command'

function paletteKind(command: PaletteCommand): PaletteKind {
  if (command.id.startsWith('tab-')) return 'tab'
  if (command.id.startsWith('bookmark-')) return 'bookmark'
  if (command.id.startsWith('history-')) return 'history'
  if (command.id.startsWith('note-')) return 'note'
  return 'command'
}

const SCOPE_KIND: Record<PaletteScope, PaletteKind> = {
  tabs: 'tab',
  bookmarks: 'bookmark',
  history: 'history',
  notes: 'note',
  commands: 'command'
}

// Same page found as an open tab, a bookmark and a history entry is listed once.
const KIND_PRIORITY: Record<PaletteKind, number> = { tab: 3, bookmark: 2, history: 1, note: 0, command: 0 }
const SECTION_LIMIT: Partial<Record<Command['section'], number>> = { Tabs: 8, Bookmarks: 6, History: 8, Notes: 5 }

function historyBoost(visitCount: number, lastVisitedAt: number, now: number): number {
  const age = now - lastVisitedAt
  const recency = age < 86_400_000 ? 10 : age < 7 * 86_400_000 ? 5 : 0
  return Math.min(24, Math.log2(visitCount + 1) * 6) + recency
}

const commandSectionOrder: Command['section'][] = ['Actions', 'Navigation', 'Tabs', 'Workspaces', 'Bookmarks', 'History', 'Notes', 'Settings', 'Search']

export function CommandPalette(): JSX.Element | null {
  const runtime = useBrowserRuntime()
  const open = useBrowserStore((state) => state.commandPaletteOpen)
  const overlayPresence = useContext(PresenceContext)
  const setOpen = useBrowserStore((state) => state.setCommandPaletteOpen)
  const setSettingsOpen = useBrowserStore((state) => state.setSettingsOpen)
  const setSmartUnloadOpen = useBrowserStore((state) => state.setSmartUnloadOpen)
  const setActiveWorkspace = useBrowserStore((state) => state.setActiveWorkspace)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const tabs = useBrowserStore((state) => state.tabs)
  const history = useBrowserStore((state) => state.history)
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const notes = useBrowserStore((state) => state.notes)
  const macros = useBrowserStore((state) => state.macros)
  const createMacro = useBrowserStore((state) => state.createMacro)
  const confirm = useVastConfirm()
  const activeWorkspaceId = useBrowserStore((state) => state.activeWorkspaceId)
  const extensionContributions = useExtensionContributions()
  const recentCommandIds = useBrowserStore((state) => state.recentCommandIds)
  const recordCommand = useBrowserStore((state) => state.recordCommand)
  const favoriteCommandIds = useBrowserStore((state) => state.settings.commandPalette.favoriteCommandIds)
  const appearance = useBrowserStore((state) => state.settings.appearance)
  const privacy = useBrowserStore((state) => state.settings.privacy)
  const security = useBrowserStore((state) => state.settings.security)
  const spoofing = useBrowserStore((state) => state.settings.spoofing)
  const labs = useBrowserStore((state) => state.settings.labs)
  const searchEngineName = useBrowserStore((state) => getSearchEngine(state.settings.defaultSearchEngine).name)
  const featureContextSettings = useMemo(() => ({ labs }) as BrowserSettings, [labs])
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const deferredQuery = useDeferredValue(query)

  const shellMotionRef = useMotionRef('backdrop')
  const panelMotionRef = useMotionRef('dialog')

  // Typing works from the first frame: focus before paint, never after the
  // entrance motion. Reopening while closing starts a fresh search.
  useLayoutEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    focusWhenReady(inputRef.current)
  }, [open])

  const commands = useMemo<PaletteCommand[]>(() => {
    const base: PaletteCommand[] = [
      {
        id: 'new-tab',
        title: 'Create new tab',
        subtitle: 'Open a fresh Vast tab',
        section: 'Navigation',
        shortcut: 'Ctrl/Cmd+T',
        keywords: ['tab', 'open'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_NEW_TAB_URL)
      },
      {
        id: 'avidae',
        title: 'Open Video & Audio',
        subtitle: 'Built-in media utility dashboard',
        section: 'Actions',
        featureId: VastFeatures.Avidae,
        keywords: ['media', 'video', 'audio', 'record', 'convert', 'ffmpeg', 'download', 'avidae'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_AVIDAE_URL)
      },
      {
        id: 'automation',
        title: 'Open Automation',
        subtitle: 'Create and run local Vast macros',
        section: 'Actions',
        featureId: VastFeatures.Automation,
        keywords: ['automation', 'macro', 'macros', 'workflow'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_AUTOMATION_URL)
      },
      {
        id: 'network-devices',
        title: 'Open Network Devices',
        subtitle: 'Discover Chromecast, AirPlay, UPnP, routers, printers, and local web panels',
        section: 'Actions',
        featureId: VastFeatures.NetworkDevices,
        keywords: ['network', 'devices', 'lan', 'mdns', 'ssdp', 'chromecast', 'cast', 'airplay', 'upnp'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_NETWORK_URL)
      },
      {
        id: 'scan-network',
        title: 'Scan Local Network',
        subtitle: 'Start a user-triggered local-only device scan',
        section: 'Actions',
        featureId: VastFeatures.NetworkDevices,
        keywords: ['network', 'scan', 'lan', 'devices', 'chromecast', 'mdns', 'ssdp'],
        perform: async () => {
          await window.vast.network.scan({ confirmed: true })
          runtime.openUrlInNewTab(INTERNAL_NETWORK_URL)
        }
      },
      {
        id: 'show-cast-devices',
        title: 'Show Cast Devices',
        subtitle: 'Open Network Devices and filter for Chromecast-style devices',
        section: 'Actions',
        featureId: VastFeatures.NetworkDevices,
        keywords: ['cast', 'chromecast', 'googlecast', 'network'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_NETWORK_URL)
      },
      {
        id: 'create-macro',
        title: 'Create Macro',
        section: 'Actions',
        featureId: VastFeatures.Automation,
        keywords: ['automation', 'macro', 'new macro'],
        perform: () => {
          createMacro({
            name: 'New Macro',
            description: 'Created from command palette.',
            icon: 'Sparkles',
            color: '#74e7ff',
            trigger: 'manual',
            actions: []
          })
          runtime.openUrlInNewTab(INTERNAL_AUTOMATION_URL)
        }
      },
      {
        id: 'notes-page',
        title: 'Open Notes',
        subtitle: 'Full-page local notebook',
        section: 'Actions',
        keywords: ['notes', 'notebook', 'markdown', 'writing'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_NOTES_URL)
      },
      {
        id: 'create-note',
        title: 'Create Note',
        section: 'Actions',
        keywords: ['notes', 'notebook', 'page note'],
        perform: () => runtime.createNoteForActive()
      },
      {
        id: 'privacy-settings',
        title: 'Open Privacy Settings',
        section: 'Settings',
        keywords: ['privacy', 'private', 'tracking'],
        perform: () => setSettingsOpen(true)
      },
      {
        id: 'security-settings',
        title: 'Open Security Settings',
        section: 'Settings',
        keywords: ['security', 'https', 'permissions'],
        perform: () => setSettingsOpen(true)
      },
      {
        id: 'toggle-tracker-blocking',
        title: `${privacy.blockTrackers ? 'Disable' : 'Enable'} Tracker Blocking`,
        subtitle: privacy.blockTrackers ? 'Known tracker blocking is on' : 'Known tracker blocking is off',
        section: 'Settings',
        keywords: ['trackers', 'tracking', 'privacy', 'block', 'toggle'],
        perform: () => updateSettings({ privacy: { blockTrackers: !privacy.blockTrackers } })
      },
      {
        id: 'toggle-tracking-parameter-cleaning',
        title: `${privacy.stripTrackingParameters ? 'Disable' : 'Enable'} Tracking Link Cleaning`,
        subtitle: privacy.stripTrackingParameters ? 'Tracking parameters are removed from opened links' : 'Opened links keep tracking parameters',
        section: 'Settings',
        keywords: ['utm', 'tracking parameters', 'clean links', 'privacy', 'toggle'],
        perform: () => updateSettings({ privacy: { stripTrackingParameters: !privacy.stripTrackingParameters } })
      },
      {
        id: 'toggle-third-party-cookies',
        title: `${privacy.blockThirdPartyCookies ? 'Allow' : 'Block'} Third-Party Cookies`,
        subtitle: privacy.blockThirdPartyCookies ? 'Cross-site cookies are currently blocked' : 'Cross-site cookies are currently allowed',
        section: 'Settings',
        keywords: ['cookies', 'third party', 'cross site', 'privacy', 'toggle'],
        perform: () => updateSettings({ privacy: { blockThirdPartyCookies: !privacy.blockThirdPartyCookies } })
      },
      {
        id: 'toggle-fingerprinting-protection',
        title: `Use ${privacy.fingerprintingProtection === 'maximum' ? 'Standard' : 'Maximum'} Fingerprinting Protection`,
        subtitle: `${privacy.fingerprintingProtection[0].toUpperCase()}${privacy.fingerprintingProtection.slice(1)} local fingerprinting protection is active`,
        section: 'Settings',
        keywords: ['fingerprint', 'canvas', 'privacy', 'anti tracking', 'standard', 'strict', 'maximum'],
        perform: () => updateSettings({ privacy: { fingerprintingProtection: privacy.fingerprintingProtection === 'maximum' ? 'standard' : 'maximum' } })
      },
      {
        id: 'toggle-spoofing',
        title: `${spoofing.enabled ? 'Disable' : 'Enable'} Spoofing`,
        subtitle: spoofing.enabled ? 'Best-effort identity spoofing is on' : labs.spoofing ? 'Best-effort identity spoofing is off' : 'Enables Spoofing tools in Labs',
        section: 'Settings',
        keywords: ['spoofing', 'user agent', 'timezone', 'identity', 'privacy', 'toggle'],
        perform: () => updateSettings(spoofing.enabled
          ? { spoofing: { enabled: false } }
          : { labs: { spoofing: true }, spoofing: { enabled: true } })
      },
      {
        id: 'toggle-https-only',
        title: `${security.httpsOnlyMode ? 'Disable' : 'Enable'} HTTPS-Only Mode`,
        subtitle: security.httpsOnlyMode ? 'HTTP navigations are upgraded when possible' : 'Automatic HTTPS upgrades are off',
        section: 'Settings',
        keywords: ['https', 'secure', 'upgrade', 'security', 'toggle'],
        perform: () => updateSettings({ security: { httpsOnlyMode: !security.httpsOnlyMode } })
      },
      {
        id: 'toggle-force-dark-websites',
        title: `${appearance.forceDarkModeWebsites ? 'Disable' : 'Enable'} Dark Mode on Websites`,
        subtitle: appearance.forceDarkModeWebsites ? 'Forced dark mode is on for websites' : 'Websites keep their own color scheme',
        section: 'Settings',
        keywords: ['dark mode', 'websites', 'appearance', 'theme', 'toggle'],
        perform: () => updateSettings({ appearance: { forceDarkModeWebsites: !appearance.forceDarkModeWebsites } })
      },
      {
        id: 'site-data',
        title: 'Open Diagnostics & Site Data',
        section: 'Settings',
        featureId: VastFeatures.AdvancedDiagnostics,
        keywords: ['site data', 'cookies', 'origins', 'permissions', 'diagnostics'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL)
      },
      {
        id: 'diagnostics',
        title: 'Open Diagnostics',
        section: 'Settings',
        featureId: VastFeatures.AdvancedDiagnostics,
        keywords: ['diagnostics', 'debug', 'dev', 'versions', 'site data', 'origins'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL)
      },
      {
        id: 'session-timeline',
        title: 'Open Session Timeline',
        subtitle: 'Review and restore workspace snapshots',
        section: 'Actions',
        featureId: VastFeatures.SessionTimeline,
        keywords: ['timeline', 'sessions', 'snapshot', 'restore'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)
      },
      {
        id: 'extensions',
        title: 'Open Extensions',
        subtitle: 'Manage Chrome-compatible website extensions',
        section: 'Actions',
        keywords: ['extensions', 'extension', 'addons', 'plugins', 'chrome'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_EXTENSIONS_URL)
      },
      {
        id: 'smart-unload',
        title: 'Open Smart Unload',
        subtitle: 'Sleep or discard inactive tabs under the RAM hard limit',
        section: 'Actions',
        keywords: ['memory', 'ram', 'unload', 'sleep', 'hibernate', 'performance'],
        perform: () => setSmartUnloadOpen(true)
      },
      {
        id: 'print-page',
        title: 'Print current page',
        section: 'Actions',
        shortcut: 'Ctrl/Cmd+P',
        keywords: ['print', 'printer', 'pdf'],
        perform: runtime.printActive
      },
      {
        id: 'save-session-snapshot',
        title: 'Save Session Snapshot',
        subtitle: 'Capture the current workspace into the local timeline',
        section: 'Actions',
        featureId: VastFeatures.SessionTimeline,
        keywords: ['timeline', 'snapshot', 'save session'],
        perform: () => void useBrowserStore.getState().addSessionSnapshot()
      },
      {
        id: 'close-tab',
        title: 'Close current tab',
        section: 'Navigation',
        shortcut: 'Ctrl/Cmd+W',
        perform: runtime.closeActiveTab
      },
      {
        id: 'duplicate-tab',
        title: 'Duplicate current tab',
        section: 'Navigation',
        perform: runtime.duplicateActiveTab
      },
      {
        id: 'reopen-tab',
        title: 'Reopen closed tab',
        section: 'Navigation',
        shortcut: 'Ctrl/Cmd+Shift+T',
        perform: runtime.reopenClosedTab
      },
      {
        id: 'toggle-split',
        title: 'Toggle split view',
        subtitle: 'Show two tabs side by side',
        section: 'Actions',
        perform: runtime.toggleSplitView
      },
      {
        id: 'settings',
        title: 'Open settings',
        section: 'Settings',
        perform: () => setSettingsOpen(true)
      },
      {
        id: 'clear-history',
        title: 'Clear history',
        subtitle: 'Remove local browsing history',
        section: 'History',
        perform: () => confirmClearAllHistory(confirm)
      },
      {
        id: 'copy-url',
        title: 'Copy current URL',
        section: 'Actions',
        perform: runtime.copyCurrentUrl
      },
      {
        id: 'copy-title',
        title: 'Copy current page title',
        section: 'Actions',
        perform: runtime.copyCurrentTitle
      },
      {
        id: 'bookmark-current',
        title: 'Add bookmark',
        section: 'Bookmarks',
        perform: runtime.addCurrentBookmark
      },
      {
        id: 'reading-list-current',
        title: 'Save page to reading list',
        section: 'Actions',
        perform: runtime.saveCurrentToReadingList
      },
      {
        id: 'devtools',
        title: 'Toggle DevTools for current tab',
        section: 'Actions',
        perform: runtime.toggleDevTools
      }
    ]

    const annotateFeatureState = (command: PaletteCommand): PaletteCommand => {
      if (!command.featureId) return command
      const state = getFeatureState(command.featureId, { settings: featureContextSettings })
      if (state.available) return command
      return {
        ...command,
        featureState: state,
        subtitle: state.message
      }
    }

    const workspaceCommands: PaletteCommand[] = workspaces.map((workspace) => ({
      id: `workspace-${workspace.id}`,
      title: `Switch to ${workspace.name}`,
      subtitle: workspace.isPrivate ? 'Isolated workspace' : 'Workspace',
      section: 'Workspaces',
      perform: () => setActiveWorkspace(workspace.id)
    }))

    const tabCommands: PaletteCommand[] = tabs.map((tab) => ({
      id: `tab-${tab.id}`,
      title: tab.title,
      subtitle: tab.url,
      url: tab.url,
      favicon: tab.favicon,
      section: 'Tabs',
      keywords: [tab.workspaceId === activeWorkspaceId ? 'current workspace' : '', tab.pinned ? 'pinned' : ''].filter(Boolean),
      boost: 12 + (tab.workspaceId === activeWorkspaceId ? 8 : 0),
      perform: () => runtime.switchToTab(tab.id)
    }))

    const bookmarkCommands: PaletteCommand[] = bookmarks.map((bookmarkItem) => ({
      id: `bookmark-${bookmarkItem.id}`,
      title: bookmarkItem.title,
      subtitle: bookmarkItem.url,
      url: bookmarkItem.url,
      favicon: bookmarkItem.favicon,
      section: 'Bookmarks',
      boost: 8,
      perform: () => {
        const state = useBrowserStore.getState()
        const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId)
        const active = state.tabs.find((item) => item.id === workspace?.activeTabId)
        if (active?.url === INTERNAL_NEW_TAB_URL) runtime.navigateActive(bookmarkItem.url)
        else runtime.openUrlInNewTab(bookmarkItem.url)
      }
    }))

    const now = Date.now()
    const historyCommands: PaletteCommand[] = history.map((entry) => ({
      id: `history-${entry.id}`,
      title: entry.title,
      subtitle: `${entry.url} - ${formatRelativeTime(entry.lastVisitedAt)}`,
      url: entry.url,
      favicon: entry.favicon,
      section: 'History',
      boost: historyBoost(entry.visitCount, entry.lastVisitedAt, now),
      perform: () => runtime.openUrlInNewTab(entry.url)
    }))

    const noteCommands: PaletteCommand[] = notes.slice(0, 80).map((note) => ({
      id: `note-${note.id}`,
      title: note.title || 'Untitled note',
      subtitle: [note.url ? 'Linked page' : 'Local note', note.body.slice(0, 90)].filter(Boolean).join(' · '),
      section: 'Notes',
      keywords: ['note', 'markdown', note.url ?? '', ...(note.tags ?? [])],
      perform: () => runtime.openUrlInNewTab(INTERNAL_NOTES_URL)
    }))

    const settingsSections = ['Appearance', 'Advanced', 'Labs', 'Privacy', 'Security', 'Search', 'Workspaces', 'Data', 'Developer']
    if (getFeatureState(VastFeatures.NetworkDevices, { settings: featureContextSettings }).available) settingsSections.push('Network')
    if (getFeatureState(VastFeatures.Automation, { settings: featureContextSettings }).available) settingsSections.push('Automation')

    const settingsCommands: PaletteCommand[] = settingsSections.map((section) => ({
      id: `settings-${section.toLowerCase()}`,
      title: `${section} settings`,
      subtitle: `Settings › ${section}`,
      section: 'Settings',
      keywords: ['setting', 'preference', section.toLowerCase()],
      perform: () => {
        setSettingsOpen(true)
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('vast-open-settings-section', { detail: { section } })), 0)
      }
    }))

    const macroCommands: PaletteCommand[] = macros
      .filter((macro) => macro.enabled)
      .map<PaletteCommand>((macro) => ({
        id: `macro-${macro.id}`,
        title: `Run Macro: ${macro.name}`,
        subtitle: macro.description,
        section: 'Actions',
        featureId: VastFeatures.Automation,
        keywords: ['automation', 'macro', macro.trigger],
        perform: async () => { await runtime.runMacro(macro.id) }
        }))
      .map(annotateFeatureState)

    const visibleBase = base

    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    const extensionCommands: PaletteCommand[] = activeWorkspace?.isPrivate || activeWorkspace?.identity?.sessionMode === 'ephemeral' ? [] : extensionContributions.commands.filter((command) => command.available).map((command) => ({
      id: `extension-${command.key}`,
      title: command.title,
      subtitle: command.extensionName,
      section: 'Actions',
      shortcut: command.shortcutAccepted ? command.shortcut : undefined,
      keywords: ['extension', command.extensionName],
      perform: async () => { await window.vast.extensions.dispatchContribution(command.key) }
    }))

    return [...visibleBase.map(annotateFeatureState), ...extensionCommands, ...macroCommands, ...workspaceCommands, ...tabCommands, ...noteCommands, ...bookmarkCommands, ...historyCommands, ...settingsCommands]
  }, [activeWorkspaceId, appearance.forceDarkModeWebsites, bookmarks, confirm, createMacro, extensionContributions.commands, featureContextSettings, history, labs.spoofing, macros, notes, privacy.blockThirdPartyCookies, privacy.blockTrackers, privacy.fingerprintingProtection, privacy.stripTrackingParameters, runtime, security.httpsOnlyMode, setActiveWorkspace, setSettingsOpen, setSmartUnloadOpen, spoofing.enabled, tabs, updateSettings, workspaces])

  // Normalized search fields are built once per data change, not per keystroke.
  // Page items search their title and URL only; subtitles such as "2 hours ago"
  // would otherwise match unrelated text.
  const prepared = useMemo(() => commands.map((command) => ({
    command,
    kind: paletteKind(command),
    fields: preparePaletteItem({
      title: command.title,
      subtitle: command.url ? undefined : command.subtitle,
      url: command.url,
      keywords: command.keywords
    })
  })), [commands])

  const parsedQuery = useMemo(() => parsePaletteQuery(deferredQuery), [deferredQuery])

  const filtered = useMemo(() => {
    const recentRank = new Map(recentCommandIds.map((id, index) => [id, recentCommandIds.length - index]))
    const { scope, text, tokens } = parsedQuery
    const usage = (command: PaletteCommand): number =>
      (recentRank.get(command.id) ?? 0) * 4 + (favoriteCommandIds.includes(command.id) ? 40 : 0)

    if (!scope && tokens.length === 0) {
      return commands
        .map((command) => ({ command, score: 1 + usage(command) }))
        .sort((a, b) => commandSectionOrder.indexOf(a.command.section) - commandSectionOrder.indexOf(b.command.section) || b.score - a.score)
        .map((item) => item.command)
        .slice(0, 48)
    }

    const scored: Array<{ command: PaletteCommand; kind: PaletteKind; score: number }> = []
    for (const item of prepared) {
      if (scope && item.kind !== SCOPE_KIND[scope]) continue
      const match = scorePaletteItem(item.fields, tokens)
      // Usage boosts only reorder matches; they never admit a non-match.
      if (match === 0) continue
      scored.push({ command: item.command, kind: item.kind, score: match + (item.command.boost ?? 0) + usage(item.command) })
    }

    const bestByUrl = new Map<string, (typeof scored)[number]>()
    const unique: typeof scored = []
    for (const item of scored) {
      if (!item.command.url || item.kind === 'command' || item.kind === 'note') {
        unique.push(item)
        continue
      }
      const key = paletteUrlKey(item.command.url)
      const existing = bestByUrl.get(key)
      if (!existing || KIND_PRIORITY[item.kind] > KIND_PRIORITY[existing.kind] ||
          (KIND_PRIORITY[item.kind] === KIND_PRIORITY[existing.kind] && item.score > existing.score)) {
        bestByUrl.set(key, item)
      }
    }
    unique.push(...bestByUrl.values())

    // Sections are ordered by their best match, items by score within them.
    const sections = new Map<Command['section'], typeof scored>()
    for (const item of unique.sort((a, b) => b.score - a.score)) {
      const list = sections.get(item.command.section) ?? []
      if (list.length < (scope ? 48 : SECTION_LIMIT[item.command.section] ?? 8)) list.push(item)
      sections.set(item.command.section, list)
    }
    const items: PaletteCommand[] = [...sections.values()].flat().map((item) => item.command).slice(0, 48)

    if (!scope || scope === 'commands') {
      if (text && looksLikeUrl(text)) {
        items.unshift({
          id: 'open-url',
          title: `Open ${text}`,
          subtitle: 'Go to this address',
          section: 'Search',
          url: /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`,
          perform: () => runtime.openUrlInNewTab(text)
        })
      }
      if (text) {
        items.push({
          id: 'search-web',
          title: `Search ${searchEngineName} for "${text}"`,
          subtitle: 'Default search engine',
          section: 'Search',
          perform: () => runtime.openUrlInNewTab(text)
        })
      }
    }
    return items
  }, [commands, favoriteCommandIds, parsedQuery, prepared, recentCommandIds, runtime, searchEngineName])

  useEffect(() => {
    setSelected(0)
  }, [query])

  // Inside an App overlay presence the parent unmounts this after its exit motion.
  if (!open && !overlayPresence) return null

  const run = async (command: PaletteCommand): Promise<void> => {
    if (command.featureState && !command.featureState.available) {
      if (command.featureState.internalUrl) runtime.openUrlInNewTab(command.featureState.internalUrl)
      else setSettingsOpen(true)
      recordCommand(command.id)
      setOpen(false)
      return
    }
    await command.perform()
    recordCommand(command.id)
    setOpen(false)
  }

  const toggleFavorite = (commandId: string): void => {
    const nextFavoriteCommandIds = favoriteCommandIds.includes(commandId)
      ? favoriteCommandIds.filter((id) => id !== commandId)
      : [commandId, ...favoriteCommandIds].slice(0, 24)
    updateSettings({ commandPalette: { favoriteCommandIds: nextFavoriteCommandIds } })
  }

  return (
    <div ref={shellMotionRef} style={{ backdropFilter: 'blur(var(--vast-dialog-backdrop-blur))' }} className="command-palette-shell fixed inset-0 z-50 flex items-start justify-center bg-black/46 px-3 pt-[clamp(2rem,9vh,7rem)] sm:px-5">
      <button className="absolute inset-0 cursor-default" aria-label="Close command palette" onClick={() => setOpen(false)} />
      <div ref={panelMotionRef} className="command-palette-panel relative w-full max-w-3xl overflow-hidden rounded-panel border">
        <div className="command-palette-search flex items-center gap-3 border-b border-white/6.5 px-5 py-4">
          <div className="command-palette-symbol grid h-10 w-10 place-items-center rounded-card border text-vast-cyan">
            <CommandIcon className="h-5 w-5" />
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((index) => Math.min(index + 1, filtered.length - 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((index) => Math.max(index - 1, 0))
              }
              if (event.key === 'Enter' && filtered[selected]) {
                event.preventDefault()
                void run(filtered[selected])
              }
              // Shift+Delete removes the highlighted history entry, as in Chrome.
              if (event.key === 'Delete' && event.shiftKey && filtered[selected]?.id.startsWith('history-')) {
                event.preventDefault()
                void deleteHistory({ ids: [filtered[selected].id.slice('history-'.length)] })
              }
            }}
            placeholder="Command, tab, bookmark, history, or search"
            aria-label="Search commands, tabs, bookmarks, history, and the web"
            className="command-palette-input h-12 min-w-0 flex-1 bg-transparent text-[17px] font-medium text-white outline-hidden placeholder:text-vast-soft"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="vast-icon-button vast-icon-button--quiet grid place-items-center h-9 w-9 rounded-control"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[min(68vh,680px)] overflow-y-auto p-2.5">
          {filtered.map((command, index) => (
            <div key={command.id}>
            {(index === 0 || filtered[index - 1]?.section !== command.section) && (
              <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-vast-soft">{command.section}</div>
            )}
            <button
              type="button"
              // mouseenter also fires when rows scroll under a still pointer,
              // which re-rendered the list during every scroll.
              onMouseMove={(event) => {
                if ((event.movementX !== 0 || event.movementY !== 0) && index !== selected) setSelected(index)
              }}
              onClick={() => void run(command)}
              className={`command-palette-item group flex w-full items-center gap-3 rounded-card px-3 py-3 text-left transition ${index === selected ? 'is-selected' : ''}`}
            >
              <CommandGlyph command={command} active={index === selected} activeWorkspaceId={activeWorkspaceId} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{command.title}</div>
              {command.subtitle && <div className="mt-0.5 truncate text-xs text-vast-soft">{command.subtitle}</div>}
              </div>
              <span
                role="button"
                tabIndex={0}
                aria-label={favoriteCommandIds.includes(command.id) ? 'Remove from favorites' : 'Add to favorites'}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleFavorite(command.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    toggleFavorite(command.id)
                  }
                }}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-control transition hover:bg-white/10 ${favoriteCommandIds.includes(command.id) ? 'text-vast-cyan' : 'text-vast-soft/55 opacity-0 group-hover:opacity-100'}`}
              >
                <Star className={`h-3.5 w-3.5 ${favoriteCommandIds.includes(command.id) ? 'fill-current' : ''}`} />
              </span>
              {command.shortcut && <kbd className="text-[11px] text-vast-soft">{command.shortcut}</kbd>}
            </button>
            </div>
          ))}
          {filtered.length === 0 && <div className="px-4 py-12 text-center text-sm text-vast-soft">{parsedQuery.scope ? `No ${parsedQuery.scope} match this search.` : 'No commands, tabs, notes, or settings match this search.'}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/6.5 px-5 py-2 text-[11px] text-vast-soft">
          <span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>
          {filtered[selected]?.id.startsWith('history-') && <span><kbd>Shift+Del</kbd> remove from history</span>}
          <span className="ml-auto">{parsedQuery.scope ? `Searching ${parsedQuery.scope}` : '@tabs @history @bookmarks @notes · > commands'}</span>
        </div>
      </div>
    </div>
  )
}

function CommandGlyph({
  command,
  active,
  activeWorkspaceId
}: {
  command: Command
  active: boolean
  activeWorkspaceId: string
}): JSX.Element {
  const className = `h-4 w-4 ${active ? 'text-vast-cyan' : 'text-vast-soft'}`
  if (command.id.startsWith('tab-') && command.url) return <Favicon url={command.url} favicon={command.favicon} title={command.title} />
  if (command.id.startsWith('bookmark-') && command.url) return <Favicon url={command.url} favicon={command.favicon} title={command.title} />
  if (command.id.startsWith('history-') && command.url) return <Favicon url={command.url} favicon={command.favicon} title={command.title} />
  if (command.id.startsWith('tab-')) return <Globe2 className={className} />
  if (command.id.startsWith('bookmark-')) return <Bookmark className={className} />
  if (command.id.startsWith('history-')) return <History className={className} />
  if (command.id.startsWith('workspace-')) {
    return <div className={`h-2.5 w-2.5 vast-geometry-circle ${command.id.endsWith(activeWorkspaceId) ? 'bg-vast-cyan' : 'bg-white/35'}`} />
  }
  if (command.id === 'search-web') return <Search className={className} />
  if (command.id === 'new-tab') return <Plus className={className} />
  if (command.id === 'avidae') return <VideoAudioMark className={className} />
  if (command.id === 'automation' || command.id === 'create-macro' || command.id.startsWith('macro-')) return <Sparkles className={className} />
  if (command.id === 'network-devices' || command.id === 'scan-network' || command.id === 'show-cast-devices') return <Wifi className={className} />
  if (command.id === 'notes-page' || command.id === 'create-note') return <FileText className={className} />
  if (command.id === 'site-data') return <Database className={className} />
  if (command.id === 'diagnostics') return <Shield className={className} />
  if (command.id === 'toggle-tracker-blocking') return <Shield className={className} />
  if (command.id === 'toggle-tracking-parameter-cleaning') return <Link2Off className={className} />
  if (command.id === 'toggle-third-party-cookies') return <Cookie className={className} />
  if (command.id === 'toggle-fingerprinting-protection' || command.id === 'toggle-spoofing') return <Fingerprint className={className} />
  if (command.id === 'toggle-https-only') return <LockKeyhole className={className} />
  if (command.id === 'toggle-force-dark-websites') return <Moon className={className} />
  if (command.id === 'session-timeline' || command.id === 'save-session-snapshot') return <History className={className} />
  if (command.id === 'smart-unload') return <Gauge className={className} />
  if (command.id === 'print-page') return <Printer className={className} />
  if (command.id === 'reopen-tab') return <RotateCcw className={className} />
  if (command.id === 'toggle-split') return <SplitSquareHorizontal className={className} />
  if (command.id === 'settings') return <Settings className={className} />
  if (command.id === 'clear-history') return <Trash2 className={className} />
  if (command.id === 'copy-url' || command.id === 'copy-title') return <Copy className={className} />
  if (command.id === 'bookmark-current') return <Star className={className} />
  if (command.id === 'reading-list-current') return <PanelRight className={className} />
  return <CommandIcon className={className} />
}
