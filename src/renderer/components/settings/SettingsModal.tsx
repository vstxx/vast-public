import { Activity, Code2, Database, Eraser, FileDown, FileUp, Fingerprint, FlaskConical, FolderOpen, History, Keyboard, KeyRound, LockKeyhole, MapPin, MonitorCheck, Palette, Plus, RefreshCw, Search, Shield, Sparkles, Trash2, Wifi, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, INTERNAL_AUTOMATION_URL, INTERNAL_DIAGNOSTICS_URL, INTERNAL_NETWORK_URL, INTERNAL_PASSWORDS_URL, INTERNAL_SESSION_TIMELINE_URL, INTERNAL_SITE_DATA_URL, SEARCH_ENGINES } from '../../../shared/constants'
import { getFeatureState, VastFeatures, type FeatureId, type FeatureState } from '../../../shared/feature-gates'
import { resolveLayoutMode } from '../../../shared/layout-mode'
import { parseShortcut } from '../../../shared/shortcuts'
import type { AdBlockerMode, CatAddonState, DataPathInfo, DefaultBrowserStatus, FingerprintingProtectionMode, MigrationReport, PermissionSetting, PrivacyFilterStatus, SpoofingBrowserProfile, SpoofingLocationMode, WebRtcPolicy, WorkspaceProxyMode, WorkspaceSessionMode } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { useBrowserStore, selectActiveTab, selectActiveWorkspace } from '../../store/browser-store'
import { VastSelect, type VastSelectOption, type VastSelectSize } from '../ui/VastSelect'
import { ModalShell } from '../ui/ModalShell'
import { NotificationCard } from '../ui/NotificationCard'
import { WorkspaceAppearancePicker } from '../workspaces/WorkspaceAppearancePicker'
import { WorkspaceIcon } from '../workspaces/WorkspaceIcon'
import { normalizeSettingsSearchText, searchSettings, type SettingsSearchEntry, type SettingsSearchResult, type SettingsSearchSectionId } from './settings-search'

declare const __VAST_CAT_ADDON_AVAILABLE__: boolean

const settingsNav: ReadonlyArray<readonly [SettingsSearchSectionId, typeof Palette]> = [
  ['Appearance', Palette],
  ['Advanced', Sparkles],
  ['Labs', FlaskConical],
  ['Network', Wifi],
  ['Developer', Code2],
  ['Privacy', Shield],
  ['Spoofing', Fingerprint],
  ['Security', LockKeyhole],
  ['Site Data', Database],
  ['Search', Search],
  ['Automation', Activity],
  ['Workspaces', Plus],
  ['Shortcuts', Keyboard],
  ['Data', Database]
] as const

type SettingsSectionId = SettingsSearchSectionId

function clampRamLimitMb(value: number): number {
  return Math.min(32_768, Math.max(1_024, Math.round(value / 256) * 256))
}

function formatRamLimit(limitMb: number): string {
  const rounded = clampRamLimitMb(limitMb)
  const wholeGb = rounded / 1024
  return Number.isInteger(wholeGb) ? `${wholeGb} GB` : `${wholeGb.toFixed(1)} GB`
}

function shortcutSignature(shortcut: string): string {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return ''
  return `${parsed.ctrlOrMeta ? 'mod+' : ''}${parsed.alt ? 'alt+' : ''}${parsed.shift ? 'shift+' : ''}${parsed.key}`
}

const permissionOptions: Array<{ value: PermissionSetting; label: string }> = [
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Always allow' },
  { value: 'block', label: 'Block' }
]

const adBlockerModeOptions: Array<{ value: AdBlockerMode; label: string }> = [
  { value: 'standard', label: 'Standard - strong and compatible' },
  { value: 'strict', label: 'Strict - maximum blocking' },
  { value: 'custom', label: 'Custom' }
]

const fingerprintingOptions: Array<{ value: FingerprintingProtectionMode; label: string }> = [
  { value: 'standard', label: 'Standard - aggressive APIs' },
  { value: 'strict', label: 'Strict - stable per-site noise' },
  { value: 'maximum', label: 'Maximum - uniform profile' }
]

const webRtcOptions: Array<{ value: WebRtcPolicy; label: string }> = [
  { value: 'public-interface-only', label: 'Public interface only' },
  { value: 'default', label: 'Default (best compatibility)' },
  { value: 'disabled', label: 'Disabled' }
]

const workspaceSessionOptions: Array<{ value: WorkspaceSessionMode; label: string }> = [
  { value: 'isolated', label: 'Isolated and persistent' },
  { value: 'ephemeral', label: 'Temporary - clear on close' },
  { value: 'shared', label: 'Shared legacy session' }
]

const workspaceProxyOptions: Array<{ value: WorkspaceProxyMode; label: string }> = [
  { value: 'system', label: 'System proxy' },
  { value: 'direct', label: 'Direct connection' },
  { value: 'fixed', label: 'Custom proxy' }
]

const spoofingProfiles: Array<{ value: SpoofingBrowserProfile; label: string }> = [
  { value: 'chrome-windows', label: 'Chrome on Windows' },
  { value: 'chrome-macos', label: 'Chrome on macOS' },
  { value: 'firefox-windows', label: 'Firefox on Windows' },
  { value: 'safari-macos', label: 'Safari on macOS' },
  { value: 'custom', label: 'Custom user agent' }
]

const timezoneOptions = ['UTC', 'Europe/Warsaw', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore']
const timezoneSelectOptions = timezoneOptions.map((timezone) => ({ value: timezone, label: timezone }))
const spoofingLocationOptions: Array<{ value: SpoofingLocationMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'fixed', label: 'Fixed coordinates' }
]

function SettingsSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'medium'
}: {
  label: string
  value: T
  options: readonly VastSelectOption<T>[]
  onChange: (value: T) => void
  size?: VastSelectSize
}): JSX.Element {
  return (
    <label className="settings-select-label">
      <span className="settings-select-title" title={label}>{label}</span>
      <VastSelect
        value={value}
        options={options}
        onChange={onChange}
        ariaLabel={label}
        size={size}
        className="settings-select-control"
        dataSettingsSelect={label}
      />
    </label>
  )
}

function RangeSetting({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  suffix = '',
  onChange
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className="settings-range-label">
      <span>{label}</span>
      <div className="settings-range-control">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        />
        <output>{value}{suffix}</output>
      </div>
    </label>
  )
}

function ColorSetting({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function FeatureToggleSetting({
  label,
  checked,
  state,
  onChange
}: {
  label: string
  checked: boolean
  state: FeatureState
  onChange: (checked: boolean) => void
}): JSX.Element {
  const locked = state.state === 'ComingSoon'
  const badge = state.state === 'ComingSoon' ? 'Soon' : undefined

  return (
    <label className={locked ? 'opacity-75' : ''}>
      <span>
        <span className="flex items-center gap-2">
          {label}
          {badge && (
            <span className="inline-flex items-center gap-1 rounded-md border border-vast-cyan/20 bg-vast-cyan/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-vast-cyan">
              {badge}
            </span>
          )}
        </span>
        {locked && <span className="mt-1 block text-[11px] leading-4 text-vast-soft">{state.message}</span>}
      </span>
      <input type="checkbox" checked={checked} disabled={locked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

export function SettingsModal(): JSX.Element | null {
  const runtime = useBrowserRuntime()
  const open = useBrowserStore((state) => state.settingsOpen)
  const setOpen = useBrowserStore((state) => state.setSettingsOpen)
  const settings = useBrowserStore((state) => state.settings)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const selectedLayoutMode = resolveLayoutMode(settings.layoutMode, settings.advanced.experimentalFeatures)
  const activeTab = useBrowserStore(selectActiveTab)
  const activeWorkspace = useBrowserStore(selectActiveWorkspace)
  const tabs = useBrowserStore((state) => state.tabs)
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const history = useBrowserStore((state) => state.history)
  const notes = useBrowserStore((state) => state.notes)
  const macros = useBrowserStore((state) => state.macros)
  const downloads = useBrowserStore((state) => state.downloads)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const createWorkspace = useBrowserStore((state) => state.createWorkspace)
  const renameWorkspace = useBrowserStore((state) => state.renameWorkspace)
  const updateWorkspaceAppearance = useBrowserStore((state) => state.updateWorkspaceAppearance)
  const updateWorkspaceIdentity = useBrowserStore((state) => state.updateWorkspaceIdentity)
  const deleteWorkspace = useBrowserStore((state) => state.deleteWorkspace)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const hydrate = useBrowserStore((state) => state.hydrate)
  const clearHistory = useBrowserStore((state) => state.clearHistory)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const searchResultsRef = useRef<HTMLDivElement | null>(null)
  const searchHighlightTimerRef = useRef<number | null>(null)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('Appearance')
  const [workspaceAppearanceId, setWorkspaceAppearanceId] = useState<string | null>(null)
  const [settingsSearchQuery, setSettingsSearchQuery] = useState('')
  const [catAddonState, setCatAddonState] = useState<CatAddonState>({ enabled: false, installed: false, phase: 'disabled' })
  const catAddonOperationRef = useRef(false)
  const [shortcutDrafts, setShortcutDrafts] = useState(settings.keyboardShortcuts)
  const [defaultBrowserStatus, setDefaultBrowserStatus] = useState<DefaultBrowserStatus | null>(null)
  const [defaultBrowserMessage, setDefaultBrowserMessage] = useState('')
  const [settingDefaultBrowser, setSettingDefaultBrowser] = useState(false)

  useEffect(() => {
    if (!__VAST_CAT_ADDON_AVAILABLE__ || !window.vast.app.startup.catAddonAvailable) return
    let alive = true
    const apply = (state: CatAddonState): void => { if (alive) setCatAddonState(state) }
    void window.vast.catAddon.status().then(apply).catch((error) => apply({
      enabled: false,
      installed: false,
      phase: 'error',
      error: error instanceof Error ? error.message : String(error)
    }))
    const unsubscribe = window.vast.catAddon.onStateChanged(apply)
    return () => { alive = false; unsubscribe() }
  }, [])

  const toggleCatAddon = async (): Promise<void> => {
    if (!__VAST_CAT_ADDON_AVAILABLE__) return
    if (catAddonOperationRef.current || catAddonState.phase === 'enabling' || catAddonState.phase === 'disabling') return
    catAddonOperationRef.current = true
    try {
      if (catAddonState.enabled) {
        updateSettings({ catAddon: { enabled: false } })
        const persisted = window.vast.storage.flush(useBrowserStore.getState().toPersistedData())
        const disabled = window.vast.catAddon.disable()
        const [persistResult, state] = await Promise.all([persisted, disabled])
        setCatAddonState(persistResult.ok ? state : { ...state, error: persistResult.error ?? 'Could not persist the disabled preference.' })
        return
      }

      const state = await window.vast.catAddon.enable()
      setCatAddonState(state)
      if (!state.enabled) return
      updateSettings({ catAddon: { enabled: true } })
      const persisted = await window.vast.storage.flush(useBrowserStore.getState().toPersistedData())
      if (persisted.ok) return
      updateSettings({ catAddon: { enabled: false } })
      const rolledBack = await window.vast.catAddon.disable()
      setCatAddonState({ ...rolledBack, phase: 'error', error: persisted.error ?? 'Could not persist the Cat Addon preference.' })
    } catch (error) {
      setCatAddonState({
        enabled: false,
        installed: false,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Cat Addon operation failed.'
      })
    } finally {
      catAddonOperationRef.current = false
    }
  }
  const [dataPathInfo, setDataPathInfo] = useState<DataPathInfo | null>(null)
  const [dataActionBusy, setDataActionBusy] = useState<'export' | 'import' | 'change' | 'open' | 'backup' | null>(null)
  const [migrationReport, setMigrationReport] = useState<MigrationReport | null>(null)
  const [dataMessage, setDataMessage] = useState('')
  const [appVersion, setAppVersion] = useState('Loading...')
  const [filterStatus, setFilterStatus] = useState<PrivacyFilterStatus | null>(null)
  const [filterUpdateBusy, setFilterUpdateBusy] = useState(false)
  const featureStateFor = (featureId: FeatureId): FeatureState => getFeatureState(featureId, { settings })
  const diagnosticsState = featureStateFor(VastFeatures.AdvancedDiagnostics)
  const spoofingState = featureStateFor(VastFeatures.Spoofing)
  const availableSettingsNav = useMemo(() => settingsNav.filter(([label]) => {
    if (label === 'Labs') return settings.labs.enabled
    if (label === 'Network') return getFeatureState(VastFeatures.NetworkDevices, { settings }).available
    if (label === 'Spoofing') return getFeatureState(VastFeatures.Spoofing, { settings }).available
    if (label === 'Automation') return getFeatureState(VastFeatures.Automation, { settings }).available
    return true
  }), [settings])

  useEffect(() => {
    if (!open) return
    setShortcutDrafts(settings.keyboardShortcuts)
    setActiveSection('Appearance')
    setSettingsSearchQuery('')
  }, [open, settings.keyboardShortcuts])

  useEffect(() => () => {
    if (searchHighlightTimerRef.current !== null) window.clearTimeout(searchHighlightTimerRef.current)
  }, [])

  useEffect(() => {
    if (!open) return
    void window.vast.privacy.filterStatus().then((result) => {
      if (result.ok && result.status) setFilterStatus(result.status)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const validSections = new Set<SettingsSectionId>(availableSettingsNav.map(([label]) => label))
    const openSection = (event: Event): void => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section as SettingsSectionId | undefined
      if (!section || !validSections.has(section)) return
      setSettingsSearchQuery('')
      setActiveSection(section)
      window.requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(section)}`)?.scrollIntoView({ block: 'start' }))
    }
    window.addEventListener('vast-open-settings-section', openSection)
    return () => window.removeEventListener('vast-open-settings-section', openSection)
  }, [availableSettingsNav, open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.vast.app.getDefaultBrowserStatus().then((status) => {
      if (cancelled) return
      setDefaultBrowserStatus(status)
      setDefaultBrowserMessage(status.message)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !diagnosticsState.available) {
      setAppVersion('Diagnostics disabled')
      return
    }
    let cancelled = false
    void window.vast.app.diagnostics().then((diagnostics) => {
      if (!cancelled) setAppVersion((diagnostics as { appVersion?: string }).appVersion ?? 'Unavailable')
    })
    return () => {
      cancelled = true
    }
  }, [diagnosticsState.available, open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.vast.dataPath.info().then((info) => {
      if (!cancelled) setDataPathInfo(info)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const normalizedSettingsSearchQuery = normalizeSettingsSearchText(settingsSearchQuery)
  const availableSettingsSectionIds = useMemo(
    () => new Set<SettingsSectionId>(availableSettingsNav.map(([label]) => label)),
    [availableSettingsNav]
  )
  const dynamicSettingsSearchEntries = useMemo<SettingsSearchEntry[]>(() => Object.keys(shortcutDrafts).map((label) => ({
    section: 'Shortcuts',
    label,
    aliases: ['keyboard shortcut hotkey key binding skrot klawiszowy']
  })), [shortcutDrafts])
  const settingsSearchResults = useMemo(
    () => searchSettings(settingsSearchQuery, availableSettingsSectionIds, dynamicSettingsSearchEntries),
    [availableSettingsSectionIds, dynamicSettingsSearchEntries, settingsSearchQuery]
  )
  const visibleSettingsNav = useMemo(() => {
    if (!normalizedSettingsSearchQuery) return availableSettingsNav
    const matchingSections = new Set<SettingsSectionId>(settingsSearchResults.map((result) => result.section))
    return availableSettingsNav.filter(([label]) => matchingSections.has(label))
  }, [availableSettingsNav, normalizedSettingsSearchQuery, settingsSearchResults])
  const visibleSettingsSectionIds = useMemo(() => new Set<SettingsSectionId>(visibleSettingsNav.map(([label]) => label)), [visibleSettingsNav])
  const sectionVisible = (label: SettingsSectionId): boolean => visibleSettingsSectionIds.has(label)

  const openSettingsSearchResult = (result: SettingsSearchResult): void => {
    setActiveSection(result.section)
    window.requestAnimationFrame(() => {
      const section = scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(result.section)}`)
      if (!section) return
      const normalizedTarget = normalizeSettingsSearchText(result.label)
      const candidate = [...section.querySelectorAll<HTMLElement>('h2, h3, label, button, span')].find((element) => {
        const text = normalizeSettingsSearchText(element.innerText)
        return text === normalizedTarget || text.startsWith(`${normalizedTarget} `)
      })
      const target = candidate?.closest<HTMLElement>('label, button, [data-workspace-settings-id], .rounded-xl, .rounded-2xl') ?? candidate ?? section
      scrollRef.current?.querySelectorAll('.settings-search-highlight').forEach((element) => element.classList.remove('settings-search-highlight'))
      target.classList.add('settings-search-highlight')
      target.scrollIntoView({ block: 'center', behavior: settings.animations ? 'smooth' : 'auto' })
      if (searchHighlightTimerRef.current !== null) window.clearTimeout(searchHighlightTimerRef.current)
      searchHighlightTimerRef.current = window.setTimeout(() => {
        target.classList.remove('settings-search-highlight')
        searchHighlightTimerRef.current = null
      }, 1_800)
    })
  }

  useEffect(() => {
    if (!open || visibleSettingsNav.length === 0) return
    if (!visibleSettingsSectionIds.has(activeSection)) setActiveSection(visibleSettingsNav[0][0])
  }, [activeSection, open, visibleSettingsNav, visibleSettingsSectionIds])

  useEffect(() => {
    if (!open) return
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    let frame = 0
    const sectionIds = visibleSettingsNav.map(([label]) => label)
    const updateActiveSection = (): void => {
      frame = 0
      if (sectionIds.length === 0) return
      const scrollRect = scrollElement.getBoundingClientRect()
      const anchorLine = scrollRect.top + 96
      let nextSection = sectionIds[0]

      for (const sectionId of sectionIds) {
        const section = document.getElementById(sectionId)
        if (!section) continue
        const rect = section.getBoundingClientRect()
        if (rect.top <= anchorLine) {
          nextSection = sectionId
          continue
        }
        break
      }

      setActiveSection((current) => (current === nextSection ? current : nextSection))
    }

    const scheduleUpdate = (): void => {
      if (frame) return
      frame = window.requestAnimationFrame(updateActiveSection)
    }

    scheduleUpdate()
    scrollElement.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      scrollElement.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [open, visibleSettingsNav])

  const exportFullBackupFromSettings = async (): Promise<MigrationReport> => {
    const state = useBrowserStore.getState()
    if (!state.hydrated) {
      return { ok: false, error: 'Could not export Vast profile data because the current browser state has not finished loading.' }
    }
    const flushResult = await window.vast.storage.flush(state.toPersistedData())
    if (!flushResult.ok) {
      return {
        ok: false,
        error: `Could not export Vast profile data because the latest browser state could not be saved. ${flushResult.error ?? ''}`.trim()
      }
    }
    return window.vast.storage.exportFullBackup()
  }

  const refreshDataPathInfo = async (): Promise<void> => {
    try {
      setDataPathInfo(await window.vast.dataPath.info())
    } catch {
      // The action buttons surface concrete failures below.
    }
  }

  const runDataAction = async (
    action: NonNullable<typeof dataActionBusy>,
    task: () => Promise<MigrationReport | { ok: boolean; backup?: unknown; error?: string }>
  ): Promise<void> => {
    setDataActionBusy(action)
    setDataMessage('')
    setMigrationReport(null)
    try {
      const result = await task()
      if (!result.ok) {
        setDataMessage(result.error ?? 'Data operation failed.')
        return
      }
      if ('backup' in result) {
        setDataMessage('Local JSON restore point created.')
      } else {
        const report = result as MigrationReport
        setMigrationReport(report)
        setDataMessage(
          report.restartRequired
            ? 'Vast is restarting to finish the migration.'
            : report.path
              ? `Saved to ${report.path}`
              : 'Data operation completed.'
        )
      }
      await refreshDataPathInfo()
    } catch (error) {
      setDataMessage(error instanceof Error ? error.message : 'Data operation failed.')
    } finally {
      setDataActionBusy(null)
    }
  }

  const shortcutErrors = useMemo(() => {
    const signatures = new Map<string, string[]>()
    for (const [name, shortcut] of Object.entries(shortcutDrafts)) {
      const signature = shortcutSignature(shortcut)
      if (!signature) continue
      signatures.set(signature, [...(signatures.get(signature) ?? []), name])
    }
    const errors: Record<string, string> = {}
    for (const [name, shortcut] of Object.entries(shortcutDrafts)) {
      if (!parseShortcut(shortcut)) {
        errors[name] = 'Invalid shortcut'
        continue
      }
      const signature = shortcutSignature(shortcut)
      if (signature && (signatures.get(signature)?.length ?? 0) > 1) {
        errors[name] = 'Duplicate shortcut'
      }
    }
    return errors
  }, [shortcutDrafts])

  const openDefaultBrowserSetup = async (): Promise<void> => {
    setSettingDefaultBrowser(true)
    setDefaultBrowserMessage('Opening Windows Default Apps...')
    try {
      const result = await window.vast.app.openDefaultBrowserSettings()
      if (result.ok && result.status) {
        setDefaultBrowserStatus(result.status)
        setDefaultBrowserMessage(
          result.status.isDefault
            ? 'Vast is already the default handler for web links.'
            : 'Windows Default Apps opened. Select Vast for HTTP and HTTPS to finish.'
        )
      } else {
        setDefaultBrowserMessage(result.error ?? 'Could not open Windows Default Apps.')
      }
    } catch (error) {
      setDefaultBrowserMessage(error instanceof Error ? error.message : 'Could not open Windows Default Apps.')
    } finally {
      setSettingDefaultBrowser(false)
    }
  }

  if (!open) return null

  return (
    <ModalShell onClose={() => setOpen(false)} width="max-w-5xl" className="settings-modal-shell">
      <div className="flex h-[78vh] min-h-0 flex-col">
        <header className="settings-modal-header flex items-center justify-between px-6 py-5">
          <div>
            <div className="text-xl font-semibold text-white">Settings</div>
            <div className="mt-1 text-sm text-vast-soft">Customize Vast without sending data anywhere.</div>
          </div>
          <button
            type="button"
            title="Close settings"
            onClick={() => setOpen(false)}
            className="grid h-10 w-10 place-items-center rounded-xl text-vast-soft hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
          <nav className="settings-modal-nav p-4 text-sm text-vast-soft">
            <div className="settings-search-panel mb-3 flex h-10 items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 text-vast-soft focus-within:border-vast-cyan/40 focus-within:bg-black/30">
              <Search className="h-4 w-4 shrink-0" />
              <input
                value={settingsSearchQuery}
                onChange={(event) => setSettingsSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && settingsSearchQuery) {
                    event.preventDefault()
                    event.stopPropagation()
                    setSettingsSearchQuery('')
                  } else if (event.key === 'ArrowDown' && settingsSearchResults.length > 0) {
                    event.preventDefault()
                    searchResultsRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
                  }
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                data-testid="settings-search-input"
                className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-vast-soft"
              />
              {settingsSearchQuery && (
                <button
                  type="button"
                  title="Clear settings search"
                  aria-label="Clear settings search"
                  onClick={(event) => {
                    setSettingsSearchQuery('')
                    event.currentTarget.parentElement?.querySelector('input')?.focus()
                  }}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {normalizedSettingsSearchQuery ? (
              settingsSearchResults.length > 0 ? <>
                <div className="settings-search-count px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-vast-soft" aria-live="polite">
                  {settingsSearchResults.length} best match{settingsSearchResults.length === 1 ? '' : 'es'}
                </div>
                <div ref={searchResultsRef} className="settings-search-results">
                  {settingsSearchResults.map((result) => {
                    const Icon = settingsNav.find(([label]) => label === result.section)?.[1] ?? Search
                    return (
                      <button
                        key={`${result.section}:${result.label}`}
                        type="button"
                        data-settings-search-result={result.label}
                        data-settings-search-section={result.section}
                        onClick={() => openSettingsSearchResult(result)}
                        className="settings-search-result flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:text-white"
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold text-white">{result.label}</span>
                          <span className="mt-0.5 block truncate text-[10px] text-vast-soft">{result.section}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </> : (
              <div className="settings-search-empty rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-4 text-center">
                <Search className="mx-auto h-4 w-4 text-vast-soft" />
                <div className="mt-2 text-sm font-medium text-white">No settings found</div>
                <div className="mt-1 text-xs leading-5 text-vast-soft">Try a name, synonym, or shorter phrase.</div>
              </div>
              )
            ) : visibleSettingsNav.map(([label, Icon]) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setActiveSection(label)
                  scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(label)}`)?.scrollIntoView({ block: 'start', behavior: settings.animations ? 'smooth' : 'auto' })
                }}
                className={`settings-nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition ${
                  activeSection === label ? 'is-active text-white' : 'hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </nav>

          <div ref={scrollRef} className="settings-modal-scroll">
            <section id="Appearance" className="settings-section" hidden={!sectionVisible('Appearance')}>
              <h2>Appearance</h2>
              <div className="settings-grid">
                <SettingsSelect
                  label="Layout"
                  size="short"
                  value={selectedLayoutMode}
                  onChange={(layoutMode) => updateSettings({ layoutMode })}
                  options={[
                    { value: 'vertical', label: 'Vertical' },
                    { value: 'horizontal', label: 'Horizontal' },
                    ...(settings.advanced.experimentalFeatures
                      ? [{ value: 'purist' as const, label: 'Purist' }]
                      : [])
                  ]}
                />
                <SettingsSelect
                  label="Theme"
                  size="short"
                  value={settings.theme}
                  onChange={(theme) => updateSettings({ theme })}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'dim', label: 'Dim' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'System' }
                  ]}
                />
                <label>
                  <span>Force dark mode on websites</span>
                  <input
                    type="checkbox"
                    checked={settings.appearance.forceDarkModeWebsites}
                    onChange={(event) => updateSettings({ appearance: { forceDarkModeWebsites: event.target.checked } })}
                  />
                </label>
                <SettingsSelect
                  label="Background"
                  value={settings.appearance.backgroundStyle}
                  onChange={(backgroundStyle) => updateSettings({ appearance: { backgroundStyle } })}
                  options={[
                    { value: 'graphite', label: 'Graphite glass' },
                    { value: 'midnight', label: 'Midnight blue' },
                    { value: 'aurora', label: 'Aurora flow' },
                    { value: 'violet', label: 'Violet cinema' },
                    { value: 'carbon', label: 'Carbon minimal' },
                    { value: 'frost', label: 'Frosted light' }
                  ]}
                />
                <ColorSetting label="Accent color" value={settings.accentColor} onChange={(accentColor) => updateSettings({ accentColor })} />
                <ColorSetting
                  label="Secondary accent"
                  value={settings.appearance.secondaryAccentColor}
                  onChange={(secondaryAccentColor) => updateSettings({ appearance: { secondaryAccentColor } })}
                />
                <ColorSetting
                  label="Background tint"
                  value={settings.appearance.backgroundTintColor}
                  onChange={(backgroundTintColor) => updateSettings({ appearance: { backgroundTintColor } })}
                />
                <ColorSetting
                  label="Surface tint"
                  value={settings.appearance.surfaceTintColor}
                  onChange={(surfaceTintColor) => updateSettings({ appearance: { surfaceTintColor } })}
                />
                <SettingsSelect
                  label="Sidebar density"
                  size="short"
                  value={settings.sidebarDensity}
                  onChange={(sidebarDensity) => updateSettings({ sidebarDensity })}
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' }
                  ]}
                />
                <SettingsSelect
                  label="Sidebar mode"
                  value={settings.sidePanel.mode}
                  onChange={(mode) => updateSettings({ sidePanel: { mode } })}
                  options={[
                    { value: 'auto', label: 'Automatic' },
                    { value: 'docked', label: 'In sidebar' },
                    { value: 'overlay', label: 'Pinned over page' }
                  ]}
                />
                <RangeSetting label="Sidebar width" value={settings.sidePanel.width} min={304} max={520} suffix="px" onChange={(width) => updateSettings({ sidePanel: { width } })} />
                <label>
                  <span>Sidebar labels</span>
                  <input type="checkbox" checked={settings.sidePanel.showLabels} onChange={(event) => updateSettings({ sidePanel: { showLabels: event.target.checked } })} />
                </label>
                <RangeSetting label="Corner radius" value={settings.appearance.cornerRadius} min={6} max={36} suffix="px" onChange={(cornerRadius) => updateSettings({ appearance: { cornerRadius } })} />
                <RangeSetting label="Glassiness" value={settings.appearance.glassIntensity} onChange={(glassIntensity) => updateSettings({ appearance: { glassIntensity } })} />
                <RangeSetting label="Blur" value={settings.appearance.blurIntensity} onChange={(blurIntensity) => updateSettings({ appearance: { blurIntensity } })} />
                <RangeSetting label="Glow" value={settings.appearance.glowIntensity} onChange={(glowIntensity) => updateSettings({ appearance: { glowIntensity } })} />
                <RangeSetting label="Borders" value={settings.appearance.borderIntensity} onChange={(borderIntensity) => updateSettings({ appearance: { borderIntensity } })} />
                <RangeSetting label="Shadow depth" value={settings.appearance.shadowIntensity} onChange={(shadowIntensity) => updateSettings({ appearance: { shadowIntensity } })} />
                <RangeSetting label="Gradients" value={settings.appearance.gradientIntensity} onChange={(gradientIntensity) => updateSettings({ appearance: { gradientIntensity } })} />
                <RangeSetting label="Panel opacity" value={settings.appearance.panelOpacity} onChange={(panelOpacity) => updateSettings({ appearance: { panelOpacity } })} />
                <RangeSetting label="Chrome opacity" value={settings.appearance.chromeOpacity} onChange={(chromeOpacity) => updateSettings({ appearance: { chromeOpacity } })} />
                <RangeSetting label="Saturation" value={settings.appearance.saturation} min={80} max={145} suffix="%" onChange={(saturation) => updateSettings({ appearance: { saturation } })} />
                <label>
                  <span>Animations</span>
                  <input type="checkbox" checked={settings.animations} onChange={(event) => updateSettings({ animations: event.target.checked })} />
                </label>
                <label>
                  <span>Opening animation</span>
                  <input type="checkbox" checked={settings.openingAnimation} onChange={(event) => updateSettings({ openingAnimation: event.target.checked })} />
                </label>
                <RangeSetting
                  label="Opening sound"
                  value={settings.openingAnimationSoundVolume}
                  suffix="%"
                  onChange={(openingAnimationSoundVolume) => updateSettings({ openingAnimationSoundVolume })}
                />
                <label>
                  <span>Bookmarks bar</span>
                  <input
                    type="checkbox"
                    checked={settings.bookmarksBarVisible}
                    onChange={(event) => updateSettings({ bookmarksBarVisible: event.target.checked })}
                  />
                </label>
                <label>
                  <span>Show bookmarks bar only on New Tab</span>
                  <input
                    type="checkbox"
                    checked={settings.bookmarksBarOnlyOnNewTab}
                    disabled={!settings.bookmarksBarVisible}
                    onChange={(event) => updateSettings({ bookmarksBarOnlyOnNewTab: event.target.checked })}
                  />
                </label>
                {__VAST_CAT_ADDON_AVAILABLE__ && window.vast.app.startup.catAddonAvailable && (
                  <>
                    <label className="md:col-span-2">
                      <span>Cat Addon</span>
                      <input
                        type="checkbox"
                        checked={catAddonState.enabled}
                        disabled={catAddonState.phase === 'enabling' || catAddonState.phase === 'disabling'}
                        aria-label={catAddonState.enabled ? 'Disable Cat Addon' : 'Enable Cat Addon'}
                        onChange={() => { void toggleCatAddon() }}
                      />
                    </label>
                    {catAddonState.error && <div className="settings-inline-error md:col-span-2">{catAddonState.error}</div>}
                  </>
                )}
                <button
                  type="button"
                  className="settings-grid-action md:col-span-2"
                  onClick={() =>
                    updateSettings({
                      accentColor: DEFAULT_SETTINGS.accentColor,
                      appearance: DEFAULT_SETTINGS.appearance
                    })
                  }
                >
                  <span>Visual style</span>
                  <span className="settings-grid-action-value">Reset</span>
                </button>
              </div>
            </section>

            <section id="Advanced" className="settings-section" hidden={!sectionVisible('Advanced')}>
              <h2>Advanced</h2>
              <div className="settings-grid">
                <label>
                  <span>Compact UI density</span>
                  <input type="checkbox" checked={settings.sidebarDensity === 'compact'} onChange={(event) => updateSettings({ sidebarDensity: event.target.checked ? 'compact' : 'comfortable' })} />
                </label>
                <label>
                  <span>Memory target (best effort)</span>
                  <input
                    type="number"
                    min={1024}
                    max={32768}
                    step={256}
                    value={settings.advanced.ramLimitMb}
                    onChange={(event) => updateSettings({ advanced: { ramLimitMb: clampRamLimitMb(Number(event.target.value) || DEFAULT_SETTINGS.advanced.ramLimitMb) } })}
                  />
                </label>
                <label>
                  <span>Hibernate after minutes</span>
                  <input type="number" min={1} max={240} value={settings.advanced.hibernateAfterMinutes} onChange={(event) => updateSettings({ advanced: { hibernateAfterMinutes: Math.min(240, Math.max(1, Number(event.target.value) || 30)) } })} />
                </label>
                <label>
                  <span>Discard after minutes</span>
                  <input type="number" min={5} max={720} value={settings.advanced.discardAfterMinutes} onChange={(event) => updateSettings({ advanced: { discardAfterMinutes: Math.min(720, Math.max(5, Number(event.target.value) || 120)) } })} />
                </label>
                <label>
                  <span>Keep pinned tabs awake</span>
                  <input type="checkbox" checked={settings.advanced.keepPinnedTabsAwake} onChange={(event) => updateSettings({ advanced: { keepPinnedTabsAwake: event.target.checked } })} />
                </label>
                <label>
                  <span>Confirm before closing many tabs</span>
                  <input type="checkbox" checked={settings.advanced.confirmBeforeClosingManyTabs} onChange={(event) => updateSettings({ advanced: { confirmBeforeClosingManyTabs: event.target.checked } })} />
                </label>
                <label>
                  <span>Confirm before deleting workspace</span>
                  <input type="checkbox" checked={settings.advanced.confirmBeforeDeletingWorkspace} onChange={(event) => updateSettings({ advanced: { confirmBeforeDeletingWorkspace: event.target.checked } })} />
                </label>
                <label>
                  <span>Show advanced More actions</span>
                  <input type="checkbox" checked={settings.advanced.showAdvancedBrowserActions} onChange={(event) => updateSettings({ advanced: { showAdvancedBrowserActions: event.target.checked } })} />
                </label>
                <label>
                  <span>Show internal pages in command palette</span>
                  <input type="checkbox" checked={settings.advanced.showInternalPagesInCommandPalette} onChange={(event) => updateSettings({ advanced: { showInternalPagesInCommandPalette: event.target.checked } })} />
                </label>
                <label>
                  <span>Experimental features</span>
                  <input type="checkbox" checked={settings.advanced.experimentalFeatures} onChange={(event) => updateSettings({ advanced: { experimentalFeatures: event.target.checked } })} />
                </label>
                <label>
                  <span>Developer Mode</span>
                  <input type="checkbox" checked={settings.advanced.developerMode} onChange={(event) => updateSettings({ advanced: { developerMode: event.target.checked } })} />
                </label>
                <label>
                  <span>Enable Vast Labs</span>
                  <input type="checkbox" checked={settings.labs.enabled} onChange={(event) => updateSettings({ labs: { enabled: event.target.checked } })} />
                </label>
              </div>
              <p className="mt-3 rounded-2xl border border-cyan-400/15 bg-cyan-400/8 p-3 text-xs leading-5 text-vast-soft">
                Vast treats <span className="font-medium text-white">{formatRamLimit(settings.advanced.ramLimitMb)}</span> as the memory budget for the app shell and live webviews, then automatically limits how many background tabs stay resident.
              </p>
              <p className="mt-3 rounded-2xl border border-vast-amber/20 bg-vast-amber/10 p-3 text-xs leading-5 text-vast-soft">Experimental features can change quickly, but Vast never exposes unsafe Electron security toggles.</p>
            </section>

            <section id="Labs" className="settings-section" hidden={!sectionVisible('Labs')}>
              <h2>Labs</h2>
              <div className="settings-grid">
                <FeatureToggleSetting
                  label="Video & Audio"
                  checked={settings.labs.avidae}
                  state={featureStateFor(VastFeatures.Avidae)}
                  onChange={(avidae) => updateSettings({ labs: { avidae } })}
                />
                <FeatureToggleSetting
                  label="Network Devices"
                  checked={settings.labs.networkDevices}
                  state={featureStateFor(VastFeatures.NetworkDevices)}
                  onChange={(networkDevices) => updateSettings({ labs: { networkDevices } })}
                />
                <FeatureToggleSetting
                  label="Automation"
                  checked={settings.labs.automation}
                  state={featureStateFor(VastFeatures.Automation)}
                  onChange={(automation) => updateSettings({ labs: { automation } })}
                />
                <FeatureToggleSetting
                  label="Password Manager"
                  checked={settings.labs.passwordManager}
                  state={featureStateFor(VastFeatures.PasswordManager)}
                  onChange={(passwordManager) => updateSettings({ labs: { passwordManager } })}
                />
                <FeatureToggleSetting
                  label="Advanced diagnostics"
                  checked={settings.labs.advancedDiagnostics}
                  state={featureStateFor(VastFeatures.AdvancedDiagnostics)}
                  onChange={(advancedDiagnostics) => updateSettings({ labs: { advancedDiagnostics } })}
                />
                <FeatureToggleSetting
                  label="Spoofing tools"
                  checked={settings.labs.spoofing}
                  state={featureStateFor(VastFeatures.Spoofing)}
                  onChange={(spoofing) => updateSettings({ labs: { spoofing } })}
                />
              </div>
              <p className="mt-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-3 text-xs leading-5 text-vast-soft">
                Labs contains local, experimental feature flags. A feature is available only when both Vast Labs and its own flag are enabled; turning a flag off never removes local data.
              </p>
            </section>

            <section id="Network" className="settings-section" hidden={!sectionVisible('Network')}>
              <h2>Network Devices</h2>
              <div className="settings-grid">
                <label>
                  <span>Enable Network Devices</span>
                  <input type="checkbox" checked={settings.network.enabled} onChange={(event) => updateSettings({ network: { enabled: event.target.checked } })} />
                </label>
                <label>
                  <span>Allow local scans</span>
                  <input type="checkbox" checked={settings.network.allowScans} onChange={(event) => updateSettings({ network: { allowScans: event.target.checked } })} />
                </label>
                <label>
                  <span>Passive mDNS / SSDP discovery</span>
                  <input type="checkbox" checked={settings.network.passiveDiscovery} onChange={(event) => updateSettings({ network: { passiveDiscovery: event.target.checked } })} />
                </label>
                <label>
                  <span>Active local probing</span>
                  <input type="checkbox" checked={settings.network.activeProbing} onChange={(event) => updateSettings({ network: { activeProbing: event.target.checked } })} />
                </label>
                <label>
                  <span>Remember devices</span>
                  <input type="checkbox" checked={settings.network.rememberDevices} onChange={(event) => updateSettings({ network: { rememberDevices: event.target.checked } })} />
                </label>
                <label>
                  <span>Show raw metadata</span>
                  <input type="checkbox" checked={settings.network.showRawMetadata} onChange={(event) => updateSettings({ network: { showRawMetadata: event.target.checked } })} />
                </label>
                <label>
                  <span>Probe timeout</span>
                  <input type="number" min={250} max={3000} value={settings.network.probeTimeoutMs} onChange={(event) => updateSettings({ network: { probeTimeoutMs: Number(event.target.value) || 750 } })} />
                </label>
                <label>
                  <span>Probe concurrency</span>
                  <input type="number" min={1} max={32} value={settings.network.probeConcurrency} onChange={(event) => updateSettings({ network: { probeConcurrency: Number(event.target.value) || 16 } })} />
                </label>
                <button type="button" onClick={() => { runtime.openUrlInNewTab(INTERNAL_NETWORK_URL); setOpen(false) }} className="settings-action"><Wifi className="h-4 w-4" />Open Network Devices</button>
                <button type="button" onClick={() => void window.vast.network.clearCache()} className="settings-action"><Eraser className="h-4 w-4" />Clear network cache</button>
              </div>
              <p className="mt-3 rounded-2xl border border-vast-amber/20 bg-vast-amber/10 p-3 text-xs leading-5 text-vast-soft">
                Active probing only checks private/local ranges after a user-triggered scan. Vast never scans public IPs, attempts logins, or uploads network data.
              </p>
            </section>

            <section id="Developer" className="settings-section" hidden={!sectionVisible('Developer')}>
              <h2>Developer</h2>
              {!settings.advanced.developerMode ? (
                <NotificationCard role="status" className="settings-developer-notification border border-vast-amber/20 bg-[#11100d] text-white shadow-lg">
                  <div className="flex items-start gap-3">
                    <div className="vast-notification-icon border border-vast-amber/20 bg-vast-amber/10 text-vast-amber">
                      <Code2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">Developer Mode required</div>
                      <div className="vast-notification-message">Enable Developer Mode to access developer tools and runtime diagnostics.</div>
                      <button type="button" className="mt-3 rounded-xl border border-vast-amber/25 bg-vast-amber/10 px-3 py-1.5 text-xs font-semibold text-vast-amber transition hover:bg-vast-amber/15" onClick={() => updateSettings({ advanced: { developerMode: true } })}>Enable Developer Mode</button>
                    </div>
                  </div>
                </NotificationCard>
              ) : <>
                <div className="settings-grid">
                  <button type="button" onClick={runtime.toggleDevTools} className="settings-action"><Code2 className="h-4 w-4" />Open tab DevTools</button>
                  <button type="button" onClick={runtime.reload} className="settings-action"><Activity className="h-4 w-4" />Reload active webview</button>
                  <button type="button" onClick={() => window.location.reload()} className="settings-action"><Activity className="h-4 w-4" />Reload app chrome</button>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ appVersion, versions: window.vast.app.versions, platform: window.vast.app.platform, activeTab, activeWorkspace }, null, 2))} className="settings-action"><FileDown className="h-4 w-4" />Copy debug report</button>
                  {diagnosticsState.available && <button type="button" onClick={() => { runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL); setOpen(false) }} className="settings-action"><Activity className="h-4 w-4" />Open Diagnostics</button>}
                  <button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ counts: { tabs: tabs.length, bookmarks: bookmarks.length, history: history.length, notes: notes.length, macros: macros.length }, versions: window.vast.app.versions }, null, 2))} className="settings-action"><FileDown className="h-4 w-4" />Copy diagnostics</button>
                </div>
                <div className="mt-3 grid gap-2 rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-xs text-vast-soft md:grid-cols-2">
                  <div>Vast: {appVersion}</div>
                  <div>Electron: {window.vast.app.versions.electron}</div>
                  <div>Chromium: {window.vast.app.versions.chrome}</div>
                  <div>Node: {window.vast.app.versions.node}</div>
                  <div>Platform: {window.vast.app.platform}</div>
                  <div className="truncate">Active URL: {activeTab?.url ?? 'none'}</div>
                  <div>Lifecycle: {activeTab?.lifecycle ?? 'n/a'} / {activeTab?.status ?? 'n/a'}</div>
                  <div>Tabs: {tabs.length}</div>
                  <div>Bookmarks: {bookmarks.length}</div>
                  <div>Notes: {notes.length}</div>
                  <div>Macros: {macros.length}</div>
                </div>
              </>}
            </section>

            <section id="Privacy" className="settings-section" hidden={!sectionVisible('Privacy')}>
              <h2>Privacy</h2>
              <div className="settings-grid">
                <label>
                  <span>Block common trackers</span>
                  <input
                    type="checkbox"
                    checked={settings.privacy.blockTrackers}
                    onChange={(event) => updateSettings({ privacy: { blockTrackers: event.target.checked } })}
                  />
                </label>
                <label>
                  <span>Ad blocker</span>
                  <input
                    type="checkbox"
                    checked={settings.privacy.adBlockerEnabled}
                    onChange={(event) => updateSettings({ privacy: { adBlockerEnabled: event.target.checked } })}
                  />
                </label>
                <SettingsSelect
                  label="Ad blocking"
                  size="long"
                  value={settings.privacy.adBlockerMode ?? 'standard'}
                  options={adBlockerModeOptions}
                  onChange={(value) => updateSettings({ privacy: { adBlockerMode: value } })}
                />
                <label><span>EasyList</span><input type="checkbox" checked={settings.privacy.filterEasyList} onChange={(event) => updateSettings({ privacy: { filterEasyList: event.target.checked } })} /></label>
                <label><span>EasyPrivacy</span><input type="checkbox" checked={settings.privacy.filterEasyPrivacy} onChange={(event) => updateSettings({ privacy: { filterEasyPrivacy: event.target.checked } })} /></label>
                <label><span>Peter Lowe's ad/tracker list</span><input type="checkbox" checked={settings.privacy.filterPeterLowe} onChange={(event) => updateSettings({ privacy: { filterPeterLowe: event.target.checked } })} /></label>
                <label><span>URLhaus malware list</span><input type="checkbox" checked={settings.privacy.filterMalware} onChange={(event) => updateSettings({ privacy: { filterMalware: event.target.checked } })} /></label>
                <label><span>Polish Annoyance Filters</span><input type="checkbox" checked={settings.privacy.filterPolishAnnoyances} onChange={(event) => updateSettings({ privacy: { filterPolishAnnoyances: event.target.checked } })} /></label>
                <label><span>Automatically update filter lists</span><input type="checkbox" checked={settings.privacy.filterAutoUpdate} onChange={(event) => updateSettings({ privacy: { filterAutoUpdate: event.target.checked } })} /></label>
                {settings.privacy.adBlockerMode === 'custom' && <>
                  <label><span>Custom: block ads</span><input type="checkbox" checked={settings.privacy.customBlockAds} onChange={(event) => updateSettings({ privacy: { customBlockAds: event.target.checked } })} /></label>
                  <label><span>Custom: block trackers</span><input type="checkbox" checked={settings.privacy.customBlockTrackers} onChange={(event) => updateSettings({ privacy: { customBlockTrackers: event.target.checked } })} /></label>
                  <label><span>Custom: block malware</span><input type="checkbox" checked={settings.privacy.customBlockMalware} onChange={(event) => updateSettings({ privacy: { customBlockMalware: event.target.checked } })} /></label>
                  <label><span>Custom: block third-party cookies</span><input type="checkbox" checked={settings.privacy.customBlockThirdPartyCookies} onChange={(event) => updateSettings({ privacy: { customBlockThirdPartyCookies: event.target.checked } })} /></label>
                </>}
                <label className="md:col-span-2">
                  <span>Custom network rules (one per line; use @@||domain^ for exceptions)</span>
                  <textarea
                    value={settings.privacy.customFilterRules}
                    onChange={(event) => updateSettings({ privacy: { customFilterRules: event.target.value.slice(0, 64 * 1024) } })}
                    rows={5}
                    className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-white outline-none focus:border-vast-cyan/40"
                    placeholder={'||example-ad-network.test^\n@@||trusted.example^'}
                  />
                </label>
                <label className="md:col-span-2"><span>Ad-block allowlist (domains, comma-separated)</span><input value={settings.privacy.adBlockAllowlist.join(', ')} onChange={(event) => updateSettings({ privacy: { adBlockAllowlist: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })} /></label>
                <label><span>Clean tracking parameters while opening links</span><input type="checkbox" checked={settings.privacy.stripTrackingParameters} onChange={(event) => updateSettings({ privacy: { stripTrackingParameters: event.target.checked } })} /></label>
                <label><span>Also remove affiliate parameters</span><input type="checkbox" checked={settings.privacy.stripAffiliateParameters} onChange={(event) => updateSettings({ privacy: { stripAffiliateParameters: event.target.checked } })} /></label>
                <label><span>Block third-party cookies</span><input type="checkbox" checked={settings.privacy.blockThirdPartyCookies} onChange={(event) => updateSettings({ privacy: { blockThirdPartyCookies: event.target.checked } })} /></label>
                <label className="md:col-span-2"><span>Cookie/login exceptions (domains, comma-separated)</span><input value={settings.privacy.cookieExceptions.join(', ')} onChange={(event) => updateSettings({ privacy: { cookieExceptions: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })} /></label>
                <SettingsSelect label="Fingerprinting" size="long" value={settings.privacy.fingerprintingProtection} options={fingerprintingOptions} onChange={(value) => updateSettings({ privacy: { fingerprintingProtection: value } })} />
                <SettingsSelect label="WebRTC" size="long" value={settings.privacy.webRtcPolicy} options={webRtcOptions} onChange={(value) => updateSettings({ privacy: { webRtcPolicy: value } })} />
                <label className="md:col-span-2"><span>Fingerprinting exceptions (domains, comma-separated)</span><input value={settings.privacy.fingerprintingExceptions.join(', ')} onChange={(event) => updateSettings({ privacy: { fingerprintingExceptions: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })} /></label>
                <label className="md:col-span-2"><span>WebRTC exceptions (domains, comma-separated)</span><input value={settings.privacy.webRtcExceptions.join(', ')} onChange={(event) => updateSettings({ privacy: { webRtcExceptions: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })} /></label>
                <button type="button" className="settings-action" onClick={() => runtime.openUrlInNewTab('https://browserleaks.com/webrtc')}><Wifi className="h-4 w-4" />Open WebRTC leak test</button>
                <button
                  type="button"
                  className="settings-action"
                  disabled={filterUpdateBusy}
                  onClick={() => {
                    setFilterUpdateBusy(true)
                    void window.vast.privacy.updateFilters().then((result) => {
                      if (result.ok && result.status) setFilterStatus(result.status)
                    }).finally(() => setFilterUpdateBusy(false))
                  }}
                >
                  <RefreshCw className={`h-4 w-4 ${filterUpdateBusy ? 'animate-spin' : ''}`} />
                  {filterUpdateBusy ? 'Updating lists…' : 'Update filter lists now'}
                </button>
                <label>
                  <span>Fake browsing history</span>
                  <input
                    type="checkbox"
                    checked={settings.privacy.fakeHistoryEnabled}
                    onChange={(event) => updateSettings({ privacy: { fakeHistoryEnabled: event.target.checked } })}
                  />
                </label>
                <label>
                  <span>Clear cookies/site data on exit</span>
                  <input
                    type="checkbox"
                    checked={settings.privacy.clearCookiesOnExit}
                    onChange={(event) => updateSettings({ privacy: { clearCookiesOnExit: event.target.checked } })}
                  />
                </label>
                <label>
                  <span>Make new workspaces temporary by default</span>
                  <input
                    type="checkbox"
                    checked={settings.privacy.privateWorkspaceDefault}
                    onChange={(event) => updateSettings({ privacy: { privateWorkspaceDefault: event.target.checked } })}
                  />
                </label>
                <label>
                  <span>Disable history globally</span>
                  <input type="checkbox" checked={settings.privacy.disableHistory} onChange={(event) => updateSettings({ privacy: { disableHistory: event.target.checked } })} />
                </label>
                <label>
                  <span>Disable recently closed tabs</span>
                  <input type="checkbox" checked={settings.privacy.disableRecentlyClosedTabs} onChange={(event) => updateSettings({ privacy: { disableRecentlyClosedTabs: event.target.checked } })} />
                </label>
                <label>
                  <span>Disable page text capture</span>
                  <input type="checkbox" checked={settings.privacy.disablePageTextCapture} onChange={(event) => updateSettings({ privacy: { disablePageTextCapture: event.target.checked } })} />
                </label>
                <label>
                  <span>Disable favicons</span>
                  <input type="checkbox" checked={settings.privacy.disableFavicons} onChange={(event) => updateSettings({ privacy: { disableFavicons: event.target.checked } })} />
                </label>
                <button
                  type="button"
                  onClick={() => void window.vast.privacy.clearSiteData()}
                  className="settings-action"
                >
                  <Eraser className="h-4 w-4" />
                  Clear cookies/site data
                </button>
              </div>
              {filterStatus && <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.035] p-3 text-xs leading-5 text-vast-soft">
                <div className="font-semibold text-white">Network filter status</div>
                <div className="mt-1">Rules: {Object.values(filterStatus.ruleCounts).reduce((total, count) => total + count, 0).toLocaleString()} · updated {filterStatus.lastUpdatedAt ? new Date(filterStatus.lastUpdatedAt).toLocaleString() : 'not yet'}</div>
                <div>Blocked since Vast started: {filterStatus.blockedSinceStart.ads} ads · {filterStatus.blockedSinceStart.trackers} trackers · {filterStatus.blockedSinceStart.malware} malware. No page URLs are stored in these statistics.</div>
                {filterStatus.lastError && <div className="mt-1 text-vast-amber">{filterStatus.lastError}</div>}
              </div>}
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm"><div className="text-vast-soft">History</div><div className="mt-1 text-2xl font-semibold">{history.length}</div></div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm"><div className="text-vast-soft">Downloads</div><div className="mt-1 text-2xl font-semibold">{downloads.length}</div></div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm"><div className="text-vast-soft">Password vault</div><div className="mt-1 text-sm font-semibold">Local encrypted</div></div>
              </div>
            </section>

            <section id="Spoofing" className="settings-section" hidden={!sectionVisible('Spoofing')}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2>Spoofing</h2>
                  <p className="text-xs leading-5 text-vast-soft">Best-effort privacy controls for requests, webviews, geolocation, and common fingerprint surfaces.</p>
                </div>
                <label className="flex w-fit items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2">
                  <span>Enabled</span>
                  <input
                    type="checkbox"
                    checked={spoofingState.available && settings.spoofing.enabled}
                    title={spoofingState.available ? undefined : spoofingState.message}
                    onChange={(event) => {
                      if (!spoofingState.available) {
                        setActiveSection('Labs')
                        return
                      }
                      updateSettings({ spoofing: { enabled: event.target.checked } })
                    }}
                  />
                </label>
              </div>

              <div className="settings-grid">
                <SettingsSelect
                  label="Browser brand"
                  value={settings.spoofing.browserProfile}
                  options={spoofingProfiles}
                  onChange={(browserProfile) => updateSettings({ spoofing: { browserProfile } })}
                />
                <label>
                  <span>Languages</span>
                  <input
                    value={settings.spoofing.languages.join(', ')}
                    onChange={(event) => updateSettings({ spoofing: { languages: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })}
                    placeholder="en-US, en"
                  />
                </label>
                <SettingsSelect
                  label="Timezone"
                  value={settings.spoofing.timezone}
                  options={timezoneSelectOptions}
                  onChange={(timezone) => updateSettings({ spoofing: { timezone } })}
                />
                <label>
                  <span>Do Not Track</span>
                  <input type="checkbox" checked={settings.spoofing.doNotTrack} onChange={(event) => updateSettings({ spoofing: { doNotTrack: event.target.checked } })} />
                </label>
                {settings.spoofing.browserProfile === 'custom' && (
                  <label className="md:col-span-2">
                    <span>Custom user agent</span>
                    <input value={settings.spoofing.customUserAgent} onChange={(event) => updateSettings({ spoofing: { customUserAgent: event.target.value } })} />
                  </label>
                )}
                <label>
                  <span>CPU cores</span>
                  <input type="number" min={2} max={32} value={settings.spoofing.hardwareConcurrency} onChange={(event) => updateSettings({ spoofing: { hardwareConcurrency: Number(event.target.value) } })} />
                </label>
                <label>
                  <span>Device memory GB</span>
                  <input type="number" min={1} max={32} value={settings.spoofing.deviceMemory} onChange={(event) => updateSettings({ spoofing: { deviceMemory: Number(event.target.value) } })} />
                </label>
                <label>
                  <span>Touch points</span>
                  <input type="number" min={0} max={10} value={settings.spoofing.maxTouchPoints} onChange={(event) => updateSettings({ spoofing: { maxTouchPoints: Number(event.target.value) } })} />
                </label>
                <label>
                  <span>WebGL vendor</span>
                  <input value={settings.spoofing.webglVendor} onChange={(event) => updateSettings({ spoofing: { webglVendor: event.target.value } })} />
                </label>
                <label className="md:col-span-2">
                  <span>WebGL renderer</span>
                  <input value={settings.spoofing.webglRenderer} onChange={(event) => updateSettings({ spoofing: { webglRenderer: event.target.value } })} />
                </label>
                <SettingsSelect
                  label="Location"
                  value={settings.spoofing.location.mode}
                  options={spoofingLocationOptions}
                  onChange={(mode) => updateSettings({ spoofing: { location: { mode } } })}
                />
                <label>
                  <span>Latitude</span>
                  <input type="number" step="0.000001" min={-90} max={90} value={settings.spoofing.location.latitude} onChange={(event) => updateSettings({ spoofing: { location: { latitude: Number(event.target.value) } } })} />
                </label>
                <label>
                  <span>Longitude</span>
                  <input type="number" step="0.000001" min={-180} max={180} value={settings.spoofing.location.longitude} onChange={(event) => updateSettings({ spoofing: { location: { longitude: Number(event.target.value) } } })} />
                </label>
                <label>
                  <span>Accuracy meters</span>
                  <input type="number" min={1} max={50000} value={settings.spoofing.location.accuracy} onChange={(event) => updateSettings({ spoofing: { location: { accuracy: Number(event.target.value) } } })} />
                </label>
                <button
                  type="button"
                  onClick={() => updateSettings({ spoofing: DEFAULT_SETTINGS.spoofing })}
                  className="settings-action"
                >
                  <Fingerprint className="h-4 w-4" />
                  Reset spoofing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!spoofingState.available) {
                      setActiveSection('Labs')
                      return
                    }
                    updateSettings({ spoofing: { enabled: true, location: { mode: 'fixed', latitude: 52.2297, longitude: 21.0122, accuracy: 25 }, timezone: 'Europe/Warsaw', languages: ['pl-PL', 'pl', 'en-US'] } })
                  }}
                  className="settings-action"
                >
                  <MapPin className="h-4 w-4" />
                  Use Warsaw profile
                </button>
              </div>
            </section>

            <section id="Security" className="settings-section" hidden={!sectionVisible('Security')}>
              <h2>Security</h2>
              <div className="settings-grid">
                <label><span>HTTPS-only mode</span><input type="checkbox" checked={settings.security.httpsOnlyMode} onChange={(event) => updateSettings({ security: { ...settings.security, httpsOnlyMode: event.target.checked } })} /></label>
                <label><span>External link confirmation</span><input type="checkbox" checked={settings.security.confirmExternalLinks} onChange={(event) => updateSettings({ security: { ...settings.security, confirmExternalLinks: event.target.checked } })} /></label>
                <label><span>Dangerous download warnings</span><input type="checkbox" checked={settings.security.warnDangerousDownloads} onChange={(event) => updateSettings({ security: { ...settings.security, warnDangerousDownloads: event.target.checked } })} /></label>
                <label><span>Always confirm autofill</span><input type="checkbox" checked={settings.security.alwaysConfirmAutofill} onChange={(event) => updateSettings({ security: { ...settings.security, alwaysConfirmAutofill: event.target.checked } })} /></label>
                <button type="button" onClick={() => updateSettings({ security: { ...settings.security, httpsOnlyMode: false, confirmExternalLinks: false, warnDangerousDownloads: true, alwaysConfirmAutofill: true, sitePermissions: [] } })} className="settings-action"><Shield className="h-4 w-4" />Reset security settings</button>
              </div>
              <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-sm leading-6 text-vast-soft">
                Unsafe protocols stay blocked, webSecurity stays enabled, nodeIntegration stays disabled, and sandbox stays enabled. These controls never weaken Electron isolation.
              </div>
            </section>

            <section id="Site Data" className="settings-section" hidden={!sectionVisible('Site Data')}>
              <h2>Site Data / Permissions</h2>
              <div className="settings-grid">
                <button type="button" onClick={() => runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL)} className="settings-action"><Database className="h-4 w-4" />Open Diagnostics & Site Data</button>
                <button type="button" onClick={() => void window.vast.privacy.clearSiteData()} className="settings-action"><Eraser className="h-4 w-4" />Clear cached site data</button>
                <SettingsSelect label="Camera" value={settings.security.permissionCamera} onChange={(permissionCamera: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionCamera } })} options={permissionOptions} />
                <SettingsSelect label="Microphone" value={settings.security.permissionMicrophone} onChange={(permissionMicrophone: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionMicrophone } })} options={permissionOptions} />
                <SettingsSelect label="Location" value={settings.security.permissionLocation} onChange={(permissionLocation: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionLocation } })} options={permissionOptions} />
                <SettingsSelect label="Notifications" value={settings.security.permissionNotifications} onChange={(permissionNotifications: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionNotifications } })} options={permissionOptions} />
                <SettingsSelect label="Clipboard" value={settings.security.permissionClipboard} onChange={(permissionClipboard: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionClipboard } })} options={permissionOptions} />
                <SettingsSelect label="Fullscreen" value={settings.security.permissionFullscreen} onChange={(permissionFullscreen: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionFullscreen } })} options={permissionOptions} />
              </div>
              <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <div className="mb-3 text-sm font-semibold text-white">Per-site permissions</div>
                {(settings.security.sitePermissions ?? []).length === 0 ? (
                  <div className="text-xs leading-5 text-vast-soft">No per-site permission overrides saved.</div>
                ) : (
                  <div className="grid gap-2">
                    {(settings.security.sitePermissions ?? []).map((item) => (
                      <div key={`${item.origin}-${item.workspaceId ?? 'shared'}-${item.permission}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 text-xs text-vast-soft">
                        <span className="min-w-0 truncate">{item.origin} / {workspaces.find((workspace) => workspace.id === item.workspaceId)?.name ?? 'Shared'} / {item.permission}: <span className="font-semibold text-white">{item.setting}</span></span>
                        <button
                          type="button"
                          className="text-vast-cyan"
                          onClick={() => updateSettings({ security: { ...settings.security, sitePermissions: (settings.security.sitePermissions ?? []).filter((override) => !(override.origin === item.origin && override.permission === item.permission && override.workspaceId === item.workspaceId)) } })}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section id="Search" className="settings-section" hidden={!sectionVisible('Search')}>
              <h2>Search and Startup</h2>
              <div className="settings-grid">
                <SettingsSelect
                  label="Search engine"
                  value={settings.defaultSearchEngine}
                  onChange={(defaultSearchEngine) => updateSettings({ defaultSearchEngine })}
                  options={SEARCH_ENGINES.map((engine) => ({ value: engine.id, label: engine.name }))}
                />
                <SettingsSelect
                  label="Startup"
                  size="short"
                  value={settings.startupBehavior}
                  onChange={(startupBehavior) => updateSettings({ startupBehavior })}
                  options={[
                    { value: 'restore', label: 'Restore' },
                    { value: 'new-tab', label: 'New tab' },
                    { value: 'home', label: 'Home' }
                  ]}
                />
                <SettingsSelect
                  label="New tab layout"
                  value={settings.newTabBehavior}
                  onChange={(newTabBehavior) => updateSettings({ newTabBehavior })}
                  options={[
                    { value: 'vast', label: 'Dashboard' },
                    { value: 'search', label: 'Workspace focused' },
                    { value: 'blank', label: 'Minimalist' }
                  ]}
                />
                <label>
                  <span>Compact dashboard cards</span>
                  <input type="checkbox" checked={settings.newTab.compactCards} onChange={(event) => updateSettings({ newTab: { compactCards: event.target.checked } })} />
                </label>
                {([
                  ['showQuickLinks', 'Quick links'],
                  ['showRecentPages', 'Recent pages'],
                  ['showBookmarks', 'Bookmarks'],
                  ['showTodos', 'To-do'],
                  ['showNotes', 'Notes'],
                  ['showRecentlyClosed', 'Recently closed'],
                  ['showWorkspaceSummary', 'Workspace summary'],
                  ['showSessionTimeline', 'Session timeline']
                ] as const).map(([key, label]) => (
                  <label key={key}>
                    <span>Show {label.toLowerCase()}</span>
                    <input type="checkbox" checked={settings.newTab[key]} onChange={(event) => updateSettings({ newTab: { [key]: event.target.checked } })} />
                  </label>
                ))}
                <label>
                  <span>Restore previous session</span>
                  <input
                    type="checkbox"
                    checked={settings.restorePreviousSession}
                    onChange={(event) => updateSettings({ restorePreviousSession: event.target.checked })}
                  />
                </label>
                <label>
                  <span>Hibernate inactive tabs</span>
                  <input
                    type="checkbox"
                    checked={settings.hibernateInactiveTabs}
                    onChange={(event) => updateSettings({ hibernateInactiveTabs: event.target.checked })}
                  />
                </label>
              </div>
              <div className="settings-default-browser-panel mt-4">
                <button
                  type="button"
                  onClick={() => void openDefaultBrowserSetup()}
                  disabled={settingDefaultBrowser || defaultBrowserStatus?.supported === false}
                  className="settings-action settings-default-browser-action"
                >
                  <MonitorCheck className="h-5 w-5" />
                  <span>{settingDefaultBrowser ? 'Opening Windows Default Apps...' : 'set browser as default'}</span>
                </button>
                <div className="settings-default-browser-note">
                  {defaultBrowserStatus?.supported === false
                    ? defaultBrowserStatus.message
                    : defaultBrowserMessage || 'Register Vast and open Windows Default Apps to select it for HTTP and HTTPS.'}
                </div>
              </div>
            </section>

            <section id="Automation" className="settings-section" hidden={!sectionVisible('Automation')}>
              <h2>Automation</h2>
              <div className="settings-grid">
                <button type="button" onClick={() => { runtime.openUrlInNewTab(INTERNAL_AUTOMATION_URL); setOpen(false) }} className="settings-action"><Sparkles className="h-4 w-4" />Open Automation</button>
                <button type="button" onClick={() => runtime.runMacro(macros[0]?.id ?? '')} disabled={!macros[0]} className="settings-action"><Activity className="h-4 w-4" />Run first macro</button>
                <label><span>Macros installed</span><input readOnly value={macros.length} /></label>
                <label><span>Automation model</span><input readOnly value="Visible, local, user-controlled" /></label>
              </div>
            </section>

            <section id="Workspaces" className="settings-section" hidden={!sectionVisible('Workspaces')}>
              <div className="mb-3 flex items-center justify-between">
                <h2>Workspaces</h2>
                <button
                  type="button"
                  onClick={() =>
                    openPromptDialog({
                      title: 'New workspace',
                      label: 'Workspace name',
                      placeholder: 'Research, Travel, Side project',
                      confirmLabel: 'Create workspace',
                      onConfirm: (name) => createWorkspace(name, settings.accentColor, settings.privacy.privateWorkspaceDefault)
                    })
                  }
                  className="settings-action settings-action-compact"
                >
                  <Plus className="h-4 w-4" />
                  New workspace
                </button>
              </div>
              <div className="space-y-2">
                {workspaces.map((workspace) => (
                  <div key={workspace.id} className="rounded-2xl border border-white/10 bg-white/[0.045] p-3" data-workspace-settings-id={workspace.id}>
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-xl" style={{ backgroundColor: `${workspace.color}22`, color: workspace.color }}>
                        <WorkspaceIcon name={workspace.icon} className="h-4 w-4" />
                      </span>
                      <input
                        value={workspace.name}
                        aria-label={`Rename ${workspace.name} workspace`}
                        onChange={(event) => renameWorkspace(workspace.id, event.target.value)}
                        className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none"
                      />
                      <button
                        type="button"
                        title={`Customize ${workspace.name} workspace`}
                        aria-expanded={workspaceAppearanceId === workspace.id}
                        onClick={() => setWorkspaceAppearanceId((current) => current === workspace.id ? null : workspace.id)}
                        className={`grid h-9 w-9 place-items-center rounded-xl transition hover:bg-white/10 hover:text-white ${
                          workspaceAppearanceId === workspace.id ? 'bg-white/[0.1] text-white' : 'text-vast-soft'
                        }`}
                      >
                        <Palette className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title={`Delete ${workspace.name} workspace`}
                        disabled={workspaces.length <= 1}
                        onClick={() => deleteWorkspace(workspace.id)}
                        className="grid h-9 w-9 place-items-center rounded-xl text-vast-soft hover:bg-white/10 hover:text-white disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {workspaceAppearanceId === workspace.id && (
                      <div className="mt-3">
                        <WorkspaceAppearancePicker
                          workspaceId={workspace.id}
                          icon={workspace.icon}
                          color={workspace.color}
                          onChange={(patch) => updateWorkspaceAppearance(workspace.id, patch)}
                        />
                      </div>
                    )}
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <SettingsSelect
                        label="Identity"
                        size="long"
                        value={workspace.identity?.sessionMode ?? (workspace.isPrivate ? 'ephemeral' : 'isolated')}
                        options={workspaceSessionOptions}
                        onChange={(sessionMode) => updateWorkspaceIdentity(workspace.id, { sessionMode })}
                      />
                      <SettingsSelect
                        label="Network route"
                        value={workspace.identity?.proxyMode ?? 'system'}
                        options={workspaceProxyOptions}
                        onChange={(proxyMode) => updateWorkspaceIdentity(workspace.id, { proxyMode })}
                      />
                      {(workspace.identity?.proxyMode ?? 'system') === 'fixed' && <>
                        <label><span>Proxy URL</span><input placeholder="socks5://127.0.0.1:9050" value={workspace.identity?.proxyServer ?? ''} onChange={(event) => updateWorkspaceIdentity(workspace.id, { proxyServer: event.target.value.slice(0, 2_048) })} /></label>
                        <label><span>Proxy bypass rules</span><input placeholder="&lt;local&gt;" value={workspace.identity?.proxyBypassRules ?? '<local>'} onChange={(event) => updateWorkspaceIdentity(workspace.id, { proxyBypassRules: event.target.value.slice(0, 2_048) })} /></label>
                      </>}
                    </div>
                    <p className="mt-2 text-[11px] leading-4 text-vast-soft">This identity has its own cookies, cache, localStorage, IndexedDB, service workers, logins and browser permissions. Temporary identities are destroyed with their session.</p>
                  </div>
                ))}
              </div>
            </section>

            <section id="Shortcuts" className="settings-section" hidden={!sectionVisible('Shortcuts')}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2>Keyboard Shortcuts</h2>
                  <p className="text-xs leading-5 text-vast-soft">Shortcuts are validated before they are applied.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShortcutDrafts(DEFAULT_SHORTCUTS)
                    updateSettings({ keyboardShortcuts: DEFAULT_SHORTCUTS })
                  }}
                  className="settings-action settings-action-compact"
                >
                  Reset shortcuts
                </button>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {Object.entries(shortcutDrafts).map(([name, shortcut]) => {
                  const error = shortcutErrors[name]
                  return (
                  <div key={name} className={`rounded-xl border px-3 py-2 ${error ? 'border-vast-amber/[0.35] bg-vast-amber/10' : 'border-white/[0.08] bg-white/[0.035]'}`}>
                    <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm text-vast-soft">{name}</span>
                    <div className="flex items-center gap-2">
                    <input
                      value={shortcut}
                      onChange={(event) => setShortcutDrafts((drafts) => ({ ...drafts, [name]: event.target.value }))}
                      onBlur={() => {
                        const next = shortcutDrafts[name]?.trim()
                        if (next && !shortcutErrors[name]) updateSettings({ keyboardShortcuts: { [name]: next } })
                      }}
                      className="w-36 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-right text-xs text-white outline-none focus:border-vast-cyan/40"
                    />
                    <button
                      type="button"
                      title={`Reset ${name}`}
                      onClick={() => {
                        const next = DEFAULT_SHORTCUTS[name] ?? settings.keyboardShortcuts[name]
                        setShortcutDrafts((drafts) => ({ ...drafts, [name]: next }))
                        updateSettings({ keyboardShortcuts: { [name]: next } })
                      }}
                      className="grid h-8 w-8 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    </div>
                    </div>
                    {error && <div className="mt-1 text-xs text-vast-amber">{error}</div>}
                  </div>
                )})}
              </div>
            </section>

            <section id="Data" className="settings-section" hidden={!sectionVisible('Data')}>
              <h2>Data</h2>
              <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">Current Vast data directory</div>
                    <div className="mt-1 break-all rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 text-xs text-vast-soft">
                      {dataPathInfo?.currentDataPath ?? 'Loading...'}
                    </div>
                    <div className="mt-2 text-xs leading-5 text-vast-soft">
                      {dataPathInfo?.customDataPathActive
                        ? 'A custom data directory is active. The updater preserves this location.'
                        : 'Using the default Vast profile directory. App files and user data are kept separate.'}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={dataActionBusy === 'open'}
                      onClick={() => void runDataAction('open', async () => {
                        const result = await window.vast.dataPath.openDataFolder()
                        return result.ok ? { ok: true, warnings: ['Opened current Vast data directory.'] } : result
                      })}
                      className="settings-action settings-action-compact"
                    >
                      <FolderOpen className="h-4 w-4" />
                      Open data folder
                    </button>
                    <button
                      type="button"
                      disabled={dataActionBusy === 'change'}
                      onClick={() => void runDataAction('change', () => window.vast.dataPath.changeDataDirectory())}
                      className="settings-action settings-action-compact"
                    >
                      <Database className="h-4 w-4" />
                      Change Vast data directory
                    </button>
                  </div>
                </div>
              </div>
              <div className="settings-grid">
                <button type="button" onClick={clearHistory} className="settings-action">
                  <Trash2 className="h-4 w-4" />
                  Clear history
                </button>
                <button
                  type="button"
                  onClick={() => {
                    runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)
                    setOpen(false)
                  }}
                  className="settings-action"
                >
                  <History className="h-4 w-4" />
                  Session timeline
                </button>
                <button
                  type="button"
                  onClick={() => {
                    runtime.openUrlInNewTab(INTERNAL_PASSWORDS_URL)
                    setOpen(false)
                  }}
                  className="settings-action"
                >
                  <KeyRound className="h-4 w-4" />
                  Password Manager
                </button>
                <button
                  type="button"
                  disabled={dataActionBusy === 'export'}
                  onClick={() => void runDataAction('export', exportFullBackupFromSettings)}
                  className="settings-action"
                >
                  <FileDown className="h-4 w-4" />
                  Export all Vast data
                </button>
                <button
                  type="button"
                  disabled={dataActionBusy === 'import'}
                  onClick={() => void runDataAction('import', () => window.vast.storage.importFullBackup())}
                  className="settings-action"
                >
                  <FileUp className="h-4 w-4" />
                  Import Vast data
                </button>
                <button
                  type="button"
                  disabled={dataActionBusy === 'backup'}
                  onClick={() => void runDataAction('backup', () => window.vast.storage.createBackup())}
                  className="settings-action"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span>Create local JSON restore point</span>
                    <span className="text-left text-[11px] font-medium leading-4 text-vast-soft">This is not a full device migration backup.</span>
                  </span>
                </button>
              </div>
              {(dataMessage || migrationReport) && (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-xs leading-5 text-vast-soft">
                  <div className="mb-2 text-sm font-semibold text-white">Backup report</div>
                  {dataMessage && <div>{dataMessage}</div>}
                  {migrationReport?.path && <div className="break-all">Backup path: {migrationReport.path}</div>}
                  {migrationReport?.backupPath && <div className="break-all">Previous data backup: {migrationReport.backupPath}</div>}
                  {migrationReport?.dataPath && <div className="break-all">Next data directory: {migrationReport.dataPath}</div>}
                  {typeof migrationReport?.includedFileCount === 'number' && <div>Included files: {migrationReport.includedFileCount}</div>}
                  {typeof migrationReport?.skippedFileCount === 'number' && <div>Skipped files: {migrationReport.skippedFileCount}</div>}
                  {migrationReport?.includedSections && <div>Exported sections: {migrationReport.includedSections.join(', ')}</div>}
                  {migrationReport?.importedSections && <div>Imported sections: {migrationReport.importedSections.join(', ')}</div>}
                  {migrationReport?.skippedFileDetails && migrationReport.skippedFileDetails.length > 0 && (
                    <div className="mt-2">
                      <div className="font-semibold text-white">Skipped details</div>
                      {migrationReport.skippedFileDetails.slice(0, 5).map((item) => (
                        <div key={`${item.path}:${item.reason}`} className="break-all">
                          {item.path}: {item.reason}
                        </div>
                      ))}
                    </div>
                  )}
                  {migrationReport?.warnings && migrationReport.warnings.length > 0 && (
                    <div className="mt-2 text-vast-amber">{migrationReport.warnings.slice(0, 3).join(' ')}</div>
                  )}
                </div>
              )}
            </section>

          </div>
        </div>
      </div>
    </ModalShell>
  )
}
