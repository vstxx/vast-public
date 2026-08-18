import {
  Bookmark,
  Command as CommandIcon,
  Copy,
  Database,
  FileText,
  Gauge,
  Globe2,
  History,
  KeyRound,
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
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_SESSION_TIMELINE_URL
} from '../../../shared/constants'
import { getFeatureState, VastFeatures, type FeatureId, type FeatureState } from '../../../shared/feature-gates'
import type { BrowserSettings, Command } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatRelativeTime } from '../../lib/format'
import { useBrowserStore } from '../../store/browser-store'
import { VideoAudioMark } from '../avidae/VideoAudioBrand'
import { Favicon } from '../ui/Favicon'

function fuzzyScore(haystack: string, needle: string): number {
  const source = haystack.toLowerCase()
  const query = needle.toLowerCase().trim()
  if (!query) return 1
  if (source.startsWith(query)) return 120
  if (source.includes(query)) return 80
  let score = 0
  let cursor = 0
  for (const char of query) {
    const index = source.indexOf(char, cursor)
    if (index < 0) return 0
    score += Math.max(8 - (index - cursor), 1)
    cursor = index + 1
  }
  return score
}

type PaletteCommand = Command & {
  featureId?: FeatureId
  featureState?: FeatureState
}

const commandSectionOrder: Command['section'][] = ['Actions', 'Navigation', 'Tabs', 'Workspaces', 'Bookmarks', 'History', 'Notes', 'Settings', 'Search']

export function CommandPalette(): JSX.Element | null {
  const runtime = useBrowserRuntime()
  const open = useBrowserStore((state) => state.commandPaletteOpen)
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
  const clearHistory = useBrowserStore((state) => state.clearHistory)
  const activeWorkspaceId = useBrowserStore((state) => state.activeWorkspaceId)
  const recentCommandIds = useBrowserStore((state) => state.recentCommandIds)
  const recordCommand = useBrowserStore((state) => state.recordCommand)
  const favoriteCommandIds = useBrowserStore((state) => state.settings.commandPalette.favoriteCommandIds)
  const labs = useBrowserStore((state) => state.settings.labs)
  const labsEnabled = labs.enabled
  const featureContextSettings = useMemo(() => ({ labs }) as BrowserSettings, [labs])
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const deferredQuery = useDeferredValue(query)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      window.setTimeout(() => inputRef.current?.focus(), 20)
    }
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
        id: 'password-manager',
        title: 'Open Password Manager',
        subtitle: 'Local encrypted Vast password vault',
        section: 'Actions',
        featureId: VastFeatures.PasswordManager,
        keywords: ['passwords', 'logins', 'vault', 'credentials', 'manager'],
        perform: () => runtime.openUrlInNewTab(INTERNAL_PASSWORDS_URL)
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
        perform: clearHistory
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
      perform: () => runtime.switchToTab(tab.id)
    }))

    const bookmarkCommands: PaletteCommand[] = bookmarks.slice(0, 60).map((bookmarkItem) => ({
      id: `bookmark-${bookmarkItem.id}`,
      title: bookmarkItem.title,
      subtitle: bookmarkItem.url,
      url: bookmarkItem.url,
      favicon: bookmarkItem.favicon,
      section: 'Bookmarks',
      perform: () => {
        const state = useBrowserStore.getState()
        const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId)
        const active = state.tabs.find((item) => item.id === workspace?.activeTabId)
        if (active?.url === INTERNAL_NEW_TAB_URL) runtime.navigateActive(bookmarkItem.url)
        else runtime.openUrlInNewTab(bookmarkItem.url)
      }
    }))

    const historyCommands: PaletteCommand[] = history.slice(0, 80).map((entry) => ({
      id: `history-${entry.id}`,
      title: entry.title,
      subtitle: `${entry.url} - ${formatRelativeTime(entry.lastVisitedAt)}`,
      url: entry.url,
      favicon: entry.favicon,
      section: 'History',
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

    const settingsSections = ['Appearance', 'Advanced', 'Privacy', 'Security', 'Search', 'Workspaces', 'Data', 'Developer']
    if (labsEnabled) settingsSections.splice(2, 0, 'Labs')
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
      .filter((macro) => labsEnabled && macro.enabled)
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

    const visibleBase = base.filter((command) => {
      if (!command.featureId || labsEnabled) return true
      return !getFeatureState(command.featureId, { settings: featureContextSettings }).lab
    })

    return [...visibleBase.map(annotateFeatureState), ...macroCommands, ...workspaceCommands, ...tabCommands, ...noteCommands, ...bookmarkCommands, ...historyCommands, ...settingsCommands]
  }, [activeWorkspaceId, bookmarks, clearHistory, createMacro, featureContextSettings, history, labsEnabled, macros, notes, runtime, setActiveWorkspace, setSettingsOpen, setSmartUnloadOpen, tabs, workspaces])

  const filtered = useMemo(() => {
    const recentRank = new Map(recentCommandIds.map((id, index) => [id, recentCommandIds.length - index]))
    const scored = commands
      .map((command) => {
        const haystack = `${command.title} ${command.subtitle ?? ''} ${command.section} ${(command.keywords ?? []).join(' ')}`
        const hasQuery = Boolean(deferredQuery.trim())
        const score =
          fuzzyScore(haystack, deferredQuery) +
          (recentRank.get(command.id) ?? 0) * 4 +
          (favoriteCommandIds.includes(command.id) ? 32 : 0) +
          (hasQuery && command.keywords?.includes('current workspace') ? 8 : 0)
        return { command, score }
      })
      .filter((item) => item.score > 0)
    const items = scored
      .sort((a, b) => {
        const sectionDifference = commandSectionOrder.indexOf(a.command.section) - commandSectionOrder.indexOf(b.command.section)
        return sectionDifference || b.score - a.score
      })
      .map((item) => item.command)
      .slice(0, 48)
    if (deferredQuery.trim()) {
      items.push({
        id: 'search-web',
        title: `Search the web for "${deferredQuery.trim()}"`,
        subtitle: 'Default search engine',
        section: 'Search',
        perform: () => runtime.openUrlInNewTab(deferredQuery.trim())
      })
    }
    return items
  }, [commands, deferredQuery, favoriteCommandIds, recentCommandIds, runtime])

  useEffect(() => {
    setSelected(0)
  }, [query])

  if (!open) return null

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
    <div className="command-palette-shell fixed inset-0 z-50 flex items-start justify-center bg-black/[0.46] px-3 pt-[clamp(2rem,9vh,7rem)] backdrop-blur-md sm:px-5">
      <button className="absolute inset-0 cursor-default" aria-label="Close command palette" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-3xl overflow-hidden rounded-[28px] border border-white/[0.09] bg-[#11131a]/[0.88] shadow-[0_32px_110px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.055)] ring-1 ring-white/[0.03] backdrop-blur-2xl">
        <div className="flex items-center gap-3 border-b border-white/[0.065] px-5 py-4">
          <div className="grid h-10 w-10 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.07] text-vast-cyan shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
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
            }}
            placeholder="Command, tab, bookmark, history, or search"
            className="h-12 min-w-0 flex-1 bg-transparent text-[17px] font-medium text-white outline-none placeholder:text-vast-soft"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="grid h-9 w-9 place-items-center rounded-xl text-vast-soft hover:bg-white/10 hover:text-white"
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
              onMouseEnter={() => setSelected(index)}
              onClick={() => void run(command)}
              className={`group flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${
                index === selected
                  ? 'bg-white/[0.095] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                  : 'text-vast-soft hover:bg-white/[0.055] hover:text-white'
              }`}
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
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition hover:bg-white/10 ${favoriteCommandIds.includes(command.id) ? 'text-vast-cyan' : 'text-vast-soft/55 opacity-0 group-hover:opacity-100'}`}
              >
                <Star className={`h-3.5 w-3.5 ${favoriteCommandIds.includes(command.id) ? 'fill-current' : ''}`} />
              </span>
              {command.shortcut && <kbd className="text-[11px] text-vast-soft">{command.shortcut}</kbd>}
            </button>
            </div>
          ))}
          {filtered.length === 0 && <div className="px-4 py-12 text-center text-sm text-vast-soft">No commands, tabs, notes, or settings match this search.</div>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.065] px-5 py-2 text-[11px] text-vast-soft">
          <span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span><span className="ml-auto">Favorites and recent commands rank first</span>
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
    return <div className={`h-2.5 w-2.5 rounded-full ${command.id.endsWith(activeWorkspaceId) ? 'bg-vast-cyan' : 'bg-white/[0.35]'}`} />
  }
  if (command.id === 'search-web') return <Search className={className} />
  if (command.id === 'new-tab') return <Plus className={className} />
  if (command.id === 'avidae') return <VideoAudioMark className={className} />
  if (command.id === 'password-manager') return <KeyRound className={className} />
  if (command.id === 'automation' || command.id === 'create-macro' || command.id.startsWith('macro-')) return <Sparkles className={className} />
  if (command.id === 'network-devices' || command.id === 'scan-network' || command.id === 'show-cast-devices') return <Wifi className={className} />
  if (command.id === 'notes-page' || command.id === 'create-note') return <FileText className={className} />
  if (command.id === 'site-data') return <Database className={className} />
  if (command.id === 'diagnostics') return <Shield className={className} />
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
