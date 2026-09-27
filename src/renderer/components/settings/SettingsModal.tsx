import { copyText } from '../../lib/clipboard'
import { Activity, Code2, Database, Eraser, FileDown, FileUp, Fingerprint, FlaskConical, FolderOpen, History, Keyboard, LockKeyhole, MapPin, MonitorCheck, Palette, Plus, Search, Shield, Sparkles, Trash2, Wifi, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, INTERNAL_AUTOMATION_URL, INTERNAL_DIAGNOSTICS_URL, INTERNAL_NETWORK_URL, INTERNAL_SESSION_TIMELINE_URL, INTERNAL_SITE_DATA_URL, SEARCH_ENGINES } from '../../../shared/constants'
import { getFeatureState, VastFeatures, type FeatureId, type FeatureState } from '../../../shared/feature-gates'
import { resolveLayoutMode } from '../../../shared/layout-mode'
import type { RelayClientSnapshot } from '../../../shared/relay-types'
import { parseShortcut } from '../../../shared/shortcuts'
import type { DataPathInfo, DefaultBrowserStatus, FingerprintingProtectionMode, MigrationReport, NewTabBackground, PermissionSetting, SpoofingBrowserProfile, SpoofingLocationMode, WebRtcPolicy, WorkspaceProxyMode, WorkspaceSessionMode } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { useBrowserStore, selectActiveTab, selectActiveWorkspace } from '../../store/browser-store'
import { VastSelect, type VastSelectOption } from '../ui/VastSelect'
import { IconButton } from '../ui/IconButton'
import { VastButton } from '../ui/VastButton'
import { VastChoice } from '../ui/VastChoice'
import { ModalShell } from '../ui/ModalShell'
import { NotificationCard } from '../ui/NotificationCard'
import { WorkspaceAppearancePicker } from '../workspaces/WorkspaceAppearancePicker'
import { WorkspaceIcon } from '../workspaces/WorkspaceIcon'
import { AppearancePreview } from './AppearancePreview'
import { SettingsHint } from './SettingsHint'
import { normalizeSettingsSearchText, searchSettings, type SettingsSearchEntry, type SettingsSearchResult, type SettingsSearchSectionId } from './settings-search'

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

const themeGlyphs: Record<'dark' | 'dim' | 'light', string> = { dark: '◐', dim: '◑', light: '○' }

function RowLabel({ label, help }: { label: string; help?: string }): JSX.Element {
  return <span className="settings-row-label">{help ? <SettingsHint help={help}>{label}</SettingsHint> : label}</span>
}

function ToggleRow({
  label,
  help,
  checked,
  disabled,
  onChange
}: {
  label: string
  help?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="settings-row">
      <RowLabel label={label} help={help} />
      <span className="settings-row-control">
        <input className="settings-switch" type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      </span>
    </label>
  )
}

function SelectRow<T extends string>({
  label,
  help,
  value,
  options,
  onChange
}: {
  label: string
  help?: string
  value: T
  options: readonly VastSelectOption<T>[]
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className="settings-row">
      <span className="settings-row-label settings-select-title" title={label}>{help ? <SettingsHint help={help}>{label}</SettingsHint> : label}</span>
      <span className="settings-row-control">
        <VastSelect
          value={value}
          options={options}
          onChange={onChange}
          ariaLabel={label}
          className="settings-select-control"
          dataSettingsSelect={label}
        />
      </span>
    </div>
  )
}

function RangeRow({
  label,
  help,
  value,
  min = 0,
  max = 100,
  step = 1,
  suffix = '',
  onChange
}: {
  label: string
  help?: string
  value: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className="settings-row">
      <RowLabel label={label} help={help} />
      <span className="settings-row-control">
        <span className="settings-range-control">
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
        </span>
      </span>
    </label>
  )
}

function TextRow({ label, help, ...inputProps }: { label: string; help?: string } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <label className="settings-row">
      <RowLabel label={label} help={help} />
      <span className="settings-row-control">
        <input {...inputProps} />
      </span>
    </label>
  )
}

function StackedTextRow({ label, help, ...inputProps }: { label: string; help?: string } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <label className="settings-row settings-row-stacked">
      <RowLabel label={label} help={help} />
      <span className="settings-row-control">
        <input {...inputProps} />
      </span>
    </label>
  )
}

function ActionRow({ label, help, children }: { label: string; help?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="settings-row">
      <RowLabel label={label} help={help} />
      <span className="settings-row-control">{children}</span>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="settings-row">
      <RowLabel label={label} />
      <span className="settings-row-control">
        <span className="settings-value-chip">{value}</span>
      </span>
    </div>
  )
}

function ColorRow({
  label,
  help,
  value,
  onChange
}: {
  label: string
  help?: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="settings-color-item">
      <RowLabel label={label} help={help} />
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
    <label className={locked ? 'settings-feature is-locked' : 'settings-feature'}>
      <span className="settings-feature-label">
        <span className="flex items-center gap-2">
          {label}
          {badge && (
            <span className="inline-flex items-center gap-1 rounded-checkbox border border-vast-cyan/20 bg-vast-cyan/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-vast-cyan">
              {badge}
            </span>
          )}
        </span>
        {locked && <span className="settings-row-sub">{state.message}</span>}
      </span>
      <input className="settings-switch" type="checkbox" checked={checked} disabled={locked} onChange={(event) => onChange(event.target.checked)} />
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
  const [shortcutDrafts, setShortcutDrafts] = useState(settings.keyboardShortcuts)
  const [defaultBrowserStatus, setDefaultBrowserStatus] = useState<DefaultBrowserStatus | null>(null)
  const [defaultBrowserMessage, setDefaultBrowserMessage] = useState('')
  const [settingDefaultBrowser, setSettingDefaultBrowser] = useState(false)
  const [customBackgroundDataUrl, setCustomBackgroundDataUrl] = useState<string>()
  const [customBackgroundMessage, setCustomBackgroundMessage] = useState('')
  const [choosingCustomBackground, setChoosingCustomBackground] = useState(false)

  const [dataPathInfo, setDataPathInfo] = useState<DataPathInfo | null>(null)
  const [dataActionBusy, setDataActionBusy] = useState<'export' | 'import' | 'change' | 'open' | null>(null)
  const [migrationReport, setMigrationReport] = useState<MigrationReport | null>(null)
  const [dataMessage, setDataMessage] = useState('')
  const [appVersion, setAppVersion] = useState('Loading...')
  const [relayStatusLabel, setRelayStatusLabel] = useState('status loading')
  const [systemPrefersLight, setSystemPrefersLight] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)').matches : false))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (event: MediaQueryListEvent): void => setSystemPrefersLight(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const resolvedTheme = settings.theme === 'system' ? (systemPrefersLight ? 'light' : 'dark') : settings.theme
  const featureStateFor = (featureId: FeatureId): FeatureState => getFeatureState(featureId, { settings })
  const diagnosticsState = featureStateFor(VastFeatures.AdvancedDiagnostics)
  const spoofingState = featureStateFor(VastFeatures.Spoofing)
  const availableSettingsNav = useMemo(() => settingsNav.filter(([label]) => {
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

  useEffect(() => {
    if (!open) return
    let active = true
    setCustomBackgroundMessage('')
    void window.vast.newTabBackground.get().then((result) => {
      if (active) setCustomBackgroundDataUrl(result.ok ? result.dataUrl : undefined)
    }).catch(() => {
      if (active) setCustomBackgroundDataUrl(undefined)
    })
    return () => { active = false }
  }, [open])

  useEffect(() => () => {
    if (searchHighlightTimerRef.current !== null) window.clearTimeout(searchHighlightTimerRef.current)
  }, [])


  useEffect(() => {
    if (!open) return
    let active = true
    const updateRelayStatus = (state: RelayClientSnapshot): void => {
      if (active) setRelayStatusLabel(state.enabled ? state.environment : 'disabled')
    }
    setRelayStatusLabel('status loading')
    void window.vast.relay.state().then((state) => {
      updateRelayStatus(state)
    }).catch(() => {
      if (active) setRelayStatusLabel('unavailable')
    })
    const unsubscribe = window.vast.relay.onStateChanged((state) => {
      updateRelayStatus(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
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
      const target = candidate?.closest<HTMLElement>('label, button, [data-workspace-settings-id], .settings-row, .settings-rows, .settings-feature') ?? candidate ?? section
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
    task: () => Promise<MigrationReport | { ok: boolean; error?: string }>
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
      const report = result as MigrationReport
      setMigrationReport(report)
      setDataMessage(
        report.restartRequired
          ? 'Vast is restarting to finish the migration.'
          : report.path
            ? `Saved to ${report.path}`
            : 'Data operation completed.'
      )
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

  const chooseCustomNewTabBackground = async (): Promise<void> => {
    setChoosingCustomBackground(true)
    setCustomBackgroundMessage('')
    try {
      const result = await window.vast.newTabBackground.choose()
      if (!result.ok) {
        setCustomBackgroundMessage(result.error ?? 'Could not use that image.')
        return
      }
      if (result.canceled || !result.dataUrl) return
      setCustomBackgroundDataUrl(result.dataUrl)
      updateSettings({ newTab: { background: 'custom' } })
      window.dispatchEvent(new CustomEvent('vast-new-tab-background-changed', { detail: result.dataUrl }))
    } catch (error) {
      setCustomBackgroundMessage(error instanceof Error ? error.message : 'Could not use that image.')
    } finally {
      setChoosingCustomBackground(false)
    }
  }

  if (!open) return null

  return (
    <ModalShell onClose={() => setOpen(false)} width="max-w-[1360px]" className="settings-modal-shell" ariaLabel="Settings">
      <div className="flex h-[80vh] min-h-0 flex-col">
        <header className="settings-modal-header flex h-[76px] items-center justify-between px-6">
          <div className="text-[22px] font-semibold leading-none tracking-[-0.02em] text-white">Settings</div>
          <IconButton variant="secondary" size="md" tooltip="Close settings" aria-label="Close settings" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)]">
          <nav className="settings-modal-nav p-4 pt-3.5 text-sm text-vast-soft">
            <div className="settings-search-panel mb-3 flex h-[38px] items-center gap-2 rounded-control border border-white/10 bg-white/[0.045] px-3 text-vast-soft focus-within:border-vast-cyan/40">
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
                className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-vast-soft"
              />
              {settingsSearchQuery && (
                <IconButton
                  variant="quiet"
                  size="xs"
                  className="h-6 w-6 shrink-0"
                  tooltip="Clear settings search"
                  aria-label="Clear settings search"
                  onClick={(event) => {
                    setSettingsSearchQuery('')
                    event.currentTarget.parentElement?.querySelector('input')?.focus()
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
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
                        className="settings-search-result flex w-full items-center gap-3 rounded-control px-3 py-2 text-left transition hover:text-white"
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
                <div className="settings-search-empty rounded-control border border-white/[0.08] bg-white/[0.035] px-3 py-4 text-center">
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
                className={`settings-nav-item flex w-full items-center gap-2.5 rounded-control px-2.5 text-left transition ${
                  activeSection === label ? 'is-active text-white' : 'hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          <div ref={scrollRef} className="settings-modal-scroll">
            <section id="Appearance" className="settings-section" hidden={!sectionVisible('Appearance')}>
              <div className="settings-page-head">
                <h2>Appearance</h2>
              </div>
              <div className="settings-page-grid">
                <div className="settings-stack">
                  <div className="settings-card">
                    <h3 className="settings-card-title">Preview</h3>
                    <AppearancePreview settings={settings} layoutMode={selectedLayoutMode} />
                  </div>
                  <div className="settings-card">
                    <h3 className="settings-card-title">Colors</h3>
                    <div className="settings-color-grid">
                      <ColorRow label="Accent color" help="Primary highlight color used across the interface." value={settings.accentColor} onChange={(accentColor) => updateSettings({ accentColor })} />
                      <ColorRow
                        label="Secondary accent"
                        help="Supporting color for gradients and secondary highlights."
                        value={settings.appearance.secondaryAccentColor}
                        onChange={(secondaryAccentColor) => updateSettings({ appearance: { secondaryAccentColor } })}
                      />
                      <ColorRow
                        label="Background tint"
                        help="Color blended into the browser canvas atmosphere."
                        value={settings.appearance.backgroundTintColor}
                        onChange={(backgroundTintColor) => updateSettings({ appearance: { backgroundTintColor } })}
                      />
                      <ColorRow
                        label="Surface tint"
                        help="Color blended into glass surfaces such as the address bar."
                        value={settings.appearance.surfaceTintColor}
                        onChange={(surfaceTintColor) => updateSettings({ appearance: { surfaceTintColor } })}
                      />
                    </div>
                  </div>
                  <div className="settings-rows">
                    <ToggleRow
                      label="Force dark mode on websites"
                      help="Render sites that lack their own dark theme with a dark palette."
                      checked={settings.appearance.forceDarkModeWebsites}
                      onChange={(forceDarkModeWebsites) => updateSettings({ appearance: { forceDarkModeWebsites } })}
                    />
                    <ToggleRow label="Animations" checked={settings.animations} onChange={(animations) => updateSettings({ animations })} />
                    <ToggleRow label="Opening animation" checked={settings.openingAnimation} onChange={(openingAnimation) => updateSettings({ openingAnimation })} />
                    <RangeRow
                      label="Opening sound"
                      help="Volume of the startup chime."
                      value={settings.openingAnimationSoundVolume}
                      suffix="%"
                      onChange={(openingAnimationSoundVolume) => updateSettings({ openingAnimationSoundVolume })}
                    />
                    <ToggleRow label="Bookmarks bar" checked={settings.bookmarksBarVisible} onChange={(bookmarksBarVisible) => updateSettings({ bookmarksBarVisible })} />
                    <ToggleRow
                      label="Show bookmarks bar only on New Tab"
                      checked={settings.bookmarksBarOnlyOnNewTab}
                      disabled={!settings.bookmarksBarVisible}
                      onChange={(bookmarksBarOnlyOnNewTab) => updateSettings({ bookmarksBarOnlyOnNewTab })}
                    />
                    <ToggleRow
                      label="Clean toolbar icons"
                      help="Remove button surfaces and slightly enlarge the main toolbar icons."
                      checked={settings.appearance.cleanToolbarIcons}
                      onChange={(cleanToolbarIcons) => updateSettings({ appearance: { cleanToolbarIcons } })}
                    />
                    <SelectRow
                      label="Sidebar density"
                      value={settings.sidebarDensity}
                      onChange={(sidebarDensity) => updateSettings({ sidebarDensity })}
                      options={[
                        { value: 'comfortable', label: 'Comfortable' },
                        { value: 'compact', label: 'Compact' }
                      ]}
                    />
                    <SelectRow
                      label="Sidebar mode"
                      help="Where workspace tools open: docked beside pages or pinned over them."
                      value={settings.sidePanel.mode}
                      onChange={(mode) => updateSettings({ sidePanel: { mode } })}
                      options={[
                        { value: 'auto', label: 'Automatic' },
                        { value: 'docked', label: 'In sidebar' },
                        { value: 'overlay', label: 'Pinned over page' }
                      ]}
                    />
                    <RangeRow label="Sidebar width" value={settings.sidePanel.width} min={304} max={520} suffix="px" onChange={(width) => updateSettings({ sidePanel: { width } })} />
                    <ToggleRow label="Sidebar labels" checked={settings.sidePanel.showLabels} onChange={(showLabels) => updateSettings({ sidePanel: { showLabels } })} />
                    <ActionRow label="Visual style" help="Restore the default colors, effects, and radius.">
                      <VastButton
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          updateSettings({
                            accentColor: DEFAULT_SETTINGS.accentColor,
                            appearance: DEFAULT_SETTINGS.appearance
                          })
                        }
                      >
                        Reset
                      </VastButton>
                    </ActionRow>
                  </div>
                </div>
                <div className="settings-stack">
                  <div className="settings-card">
                    <h3 className="settings-card-title">Layout</h3>
                    <div className="settings-choice-grid" role="group" aria-label="Layout">
                      {([
                        { value: 'vertical', label: 'Vertical' },
                        { value: 'horizontal', label: 'Horizontal' },
                        ...(settings.advanced.experimentalFeatures
                          ? [{ value: 'purist' as const, label: 'Purist' }]
                          : [])
                      ] as const).map((option) => (
                        <VastChoice
                          key={option.value}
                          selected={selectedLayoutMode === option.value}
                          onSelect={() => updateSettings({ layoutMode: option.value })}
                          aria-label={option.label}
                        >
                          <span className={`settings-mini-layout ${option.value}`} aria-hidden="true" />
                          <span className="settings-choice-title">{option.label}</span>
                        </VastChoice>
                      ))}
                    </div>
                  </div>
                  <div className="settings-card">
                    <h3 className="settings-card-title">Theme</h3>
                    <div className="settings-choice-grid" role="group" aria-label="Theme">
                      {(['dark', 'dim', 'light'] as const).map((value) => (
                        <VastChoice
                          key={value}
                          selected={resolvedTheme === value}
                          onSelect={() => updateSettings({ theme: value })}
                          aria-label={value === 'dark' ? 'Dark' : value === 'dim' ? 'Dim' : 'Light'}
                        >
                          <span className="settings-theme-glyph" aria-hidden="true">{themeGlyphs[value]}</span>
                          <span className="settings-choice-title">{value === 'dark' ? 'Dark' : value === 'dim' ? 'Dim' : 'Light'}</span>
                        </VastChoice>
                      ))}
                    </div>
                  </div>
                  <div className="settings-card">
                    <h3 className="settings-card-title">New Tab background</h3>
                    <div className="settings-background-grid" role="group" aria-label="New Tab background">
                      {([
                        { value: 'space-black', label: 'Space Black' },
                        { value: 'accent-gradient', label: 'Accent Gradient' },
                        { value: 'carbon-black', label: 'Carbon Black' },
                        { value: 'depth', label: 'Depth' },
                        { value: 'adaptive', label: 'Adaptive' },
                        { value: 'custom', label: choosingCustomBackground ? 'Choosing...' : 'Custom' }
                      ] satisfies Array<{ value: NewTabBackground; label: string }>).map((option) => (
                        <VastChoice
                          key={option.value}
                          selected={settings.newTab.background === option.value}
                          onSelect={() => {
                            if (option.value === 'custom') void chooseCustomNewTabBackground()
                            else updateSettings({ newTab: { background: option.value } })
                          }}
                          aria-label={option.label}
                          disabled={option.value === 'custom' && choosingCustomBackground}
                          className={`settings-background-option${settings.newTab.background === option.value ? ' is-selected' : ''}`}
                        >
                          <span
                            className={`settings-background-thumb settings-background-${option.value}`}
                            style={option.value === 'custom' && customBackgroundDataUrl
                              ? { backgroundImage: `url(${JSON.stringify(customBackgroundDataUrl)})` }
                              : undefined}
                            aria-hidden="true"
                          />
                          <span>{option.label}</span>
                        </VastChoice>
                      ))}
                    </div>
                    {customBackgroundMessage && <div className="settings-row-sub mt-2 text-vast-amber" role="status">{customBackgroundMessage}</div>}
                  </div>
                  <div className="settings-rows">
                    <RangeRow label="Corner radius" help="Base roundness shared by windows, cards, and controls." value={settings.appearance.cornerRadius} min={6} max={36} suffix="px" onChange={(cornerRadius) => updateSettings({ appearance: { cornerRadius } })} />
                    <RangeRow label="Glassiness" help="How translucent app surfaces are." value={settings.appearance.glassIntensity} onChange={(glassIntensity) => updateSettings({ appearance: { glassIntensity } })} />
                    <RangeRow label="Blur" help="Background blur behind glass surfaces." value={settings.appearance.blurIntensity} onChange={(blurIntensity) => updateSettings({ appearance: { blurIntensity } })} />
                    <RangeRow label="Glow" help="Accent light blooming around panels." value={settings.appearance.glowIntensity} onChange={(glowIntensity) => updateSettings({ appearance: { glowIntensity } })} />
                    <RangeRow label="Borders" help="Visibility of surface outlines." value={settings.appearance.borderIntensity} onChange={(borderIntensity) => updateSettings({ appearance: { borderIntensity } })} />
                    <RangeRow label="Shadow depth" help="Elevation shadows under floating surfaces." value={settings.appearance.shadowIntensity} onChange={(shadowIntensity) => updateSettings({ appearance: { shadowIntensity } })} />
                    <RangeRow label="Gradients" help="Strength of color blends in the canvas atmosphere." value={settings.appearance.gradientIntensity} onChange={(gradientIntensity) => updateSettings({ appearance: { gradientIntensity } })} />
                    <RangeRow label="Panel opacity" help="How opaque in-page panels and the address bar are." value={settings.appearance.panelOpacity} onChange={(panelOpacity) => updateSettings({ appearance: { panelOpacity } })} />
                    <RangeRow label="Chrome opacity" help="How opaque the sidebar and window chrome are." value={settings.appearance.chromeOpacity} onChange={(chromeOpacity) => updateSettings({ appearance: { chromeOpacity } })} />
                    <RangeRow label="Saturation" help="Color intensity of glass surfaces." value={settings.appearance.saturation} min={80} max={145} suffix="%" onChange={(saturation) => updateSettings({ appearance: { saturation } })} />
                  </div>
                </div>
              </div>
            </section>

            <section id="Advanced" className="settings-section" hidden={!sectionVisible('Advanced')}>
              <div className="settings-page-head">
                <h2>Advanced</h2>
              </div>
              <div className="settings-rows">
                <ToggleRow
                  label="Compact UI density"
                  help="Tighter spacing for tabs, lists, and panels."
                  checked={settings.sidebarDensity === 'compact'}
                  onChange={(compact) => updateSettings({ sidebarDensity: compact ? 'compact' : 'comfortable' })}
                />
                <TextRow
                  label="Memory target (best effort)"
                  help="Soft ceiling Vast aims to stay under by hibernating inactive tabs."
                  type="number"
                  min={1024}
                  max={32768}
                  step={256}
                  value={settings.advanced.ramLimitMb}
                  onChange={(event) => updateSettings({ advanced: { ramLimitMb: clampRamLimitMb(Number(event.target.value) || DEFAULT_SETTINGS.advanced.ramLimitMb) } })}
                />
                <TextRow
                  label="Hibernate after minutes"
                  help="Idle tabs sleep but keep their place in memory."
                  type="number"
                  min={1}
                  max={240}
                  value={settings.advanced.hibernateAfterMinutes}
                  onChange={(event) => updateSettings({ advanced: { hibernateAfterMinutes: Math.min(240, Math.max(1, Number(event.target.value) || 30)) } })}
                />
                <TextRow
                  label="Discard after minutes"
                  help="Idle tabs are fully unloaded after this delay."
                  type="number"
                  min={5}
                  max={720}
                  value={settings.advanced.discardAfterMinutes}
                  onChange={(event) => updateSettings({ advanced: { discardAfterMinutes: Math.min(720, Math.max(5, Number(event.target.value) || 120)) } })}
                />
                <ToggleRow label="Keep pinned tabs awake" checked={settings.advanced.keepPinnedTabsAwake} onChange={(keepPinnedTabsAwake) => updateSettings({ advanced: { keepPinnedTabsAwake } })} />
                <ToggleRow label="Confirm before closing many tabs" checked={settings.advanced.confirmBeforeClosingManyTabs} onChange={(confirmBeforeClosingManyTabs) => updateSettings({ advanced: { confirmBeforeClosingManyTabs } })} />
                <ToggleRow label="Confirm before deleting workspace" checked={settings.advanced.confirmBeforeDeletingWorkspace} onChange={(confirmBeforeDeletingWorkspace) => updateSettings({ advanced: { confirmBeforeDeletingWorkspace } })} />
                <ToggleRow label="Show advanced More actions" checked={settings.advanced.showAdvancedBrowserActions} onChange={(showAdvancedBrowserActions) => updateSettings({ advanced: { showAdvancedBrowserActions } })} />
                <ToggleRow label="Show internal pages in command palette" checked={settings.advanced.showInternalPagesInCommandPalette} onChange={(showInternalPagesInCommandPalette) => updateSettings({ advanced: { showInternalPagesInCommandPalette } })} />
                <ToggleRow
                  label="Experimental features"
                  help="Unlocks early work such as the Purist layout. Expect rough edges."
                  checked={settings.advanced.experimentalFeatures}
                  onChange={(experimentalFeatures) => updateSettings({ advanced: { experimentalFeatures } })}
                />
                <ToggleRow label="Developer Mode" checked={settings.advanced.developerMode} onChange={(developerMode) => updateSettings({ advanced: { developerMode } })} />
              </div>
            </section>

            <section id="Labs" className="settings-section" hidden={!sectionVisible('Labs')}>
              <div className="settings-page-head">
                <h2>Labs</h2>
              </div>
              <div className="settings-feature-grid">
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
                  label="Diagnostics"
                  checked={settings.labs.advancedDiagnostics}
                  state={featureStateFor(VastFeatures.AdvancedDiagnostics)}
                  onChange={(advancedDiagnostics) => updateSettings({ labs: { advancedDiagnostics } })}
                />
                <FeatureToggleSetting
                  label="Spoofing"
                  checked={settings.labs.spoofing}
                  state={featureStateFor(VastFeatures.Spoofing)}
                  onChange={(spoofing) => updateSettings({ labs: { spoofing } })}
                />
              </div>
            </section>

            <section id="Network" className="settings-section" hidden={!sectionVisible('Network')}>
              <div className="settings-page-head">
                <h2>Network Devices</h2>
              </div>
              <div className="settings-rows">
                <ToggleRow label="Enable Network Devices" checked={settings.network.enabled} onChange={(enabled) => updateSettings({ network: { enabled } })} />
                <ToggleRow label="Allow local scans" help="Permit scanning of the local network only." checked={settings.network.allowScans} onChange={(allowScans) => updateSettings({ network: { allowScans } })} />
                <ToggleRow
                  label="Passive mDNS / SSDP discovery"
                  help="Listen for announcements devices already send."
                  checked={settings.network.passiveDiscovery}
                  onChange={(passiveDiscovery) => updateSettings({ network: { passiveDiscovery } })}
                />
                <ToggleRow
                  label="Active local probing"
                  help="Send requests to address ranges to find devices that stay silent."
                  checked={settings.network.activeProbing}
                  onChange={(activeProbing) => updateSettings({ network: { activeProbing } })}
                />
                <ToggleRow label="Remember devices" checked={settings.network.rememberDevices} onChange={(rememberDevices) => updateSettings({ network: { rememberDevices } })} />
                <ToggleRow label="Show raw metadata" checked={settings.network.showRawMetadata} onChange={(showRawMetadata) => updateSettings({ network: { showRawMetadata } })} />
                <TextRow
                  label="Probe timeout"
                  help="How long to wait for each device response."
                  type="number"
                  min={250}
                  max={3000}
                  value={settings.network.probeTimeoutMs}
                  onChange={(event) => updateSettings({ network: { probeTimeoutMs: Number(event.target.value) || 750 } })}
                />
                <TextRow
                  label="Probe concurrency"
                  help="How many devices to probe at once."
                  type="number"
                  min={1}
                  max={32}
                  value={settings.network.probeConcurrency}
                  onChange={(event) => updateSettings({ network: { probeConcurrency: Number(event.target.value) || 16 } })}
                />
                <ActionRow label="Network Devices" help="Open the local device list.">
                  <VastButton variant="secondary" size="sm" onClick={() => { runtime.openUrlInNewTab(INTERNAL_NETWORK_URL); setOpen(false) }}><Wifi className="h-4 w-4" />Open</VastButton>
                </ActionRow>
                <ActionRow label="Network cache" help="Forget remembered devices and results.">
                  <VastButton variant="secondary" size="sm" onClick={() => void window.vast.network.clearCache()}><Eraser className="h-4 w-4" />Clear</VastButton>
                </ActionRow>
              </div>
            </section>

            <section id="Developer" className="settings-section" hidden={!sectionVisible('Developer')}>
              <div className="settings-page-head">
                <h2>Developer</h2>
              </div>
              {!settings.advanced.developerMode ? (
                <NotificationCard role="status" className="settings-developer-notification border border-vast-amber/20 bg-[#11100d] text-white shadow-lg">
                  <div className="flex items-start gap-3">
                    <div className="vast-notification-icon border border-vast-amber/20 bg-vast-amber/10 text-vast-amber">
                      <Code2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">Developer Mode required</div>
                      <div className="vast-notification-message">Enable Developer Mode to access developer tools and runtime diagnostics.</div>
                      <button type="button" className="mt-3 rounded-control border border-vast-amber/25 bg-vast-amber/10 px-3 py-1.5 text-xs font-semibold text-vast-amber transition hover:bg-vast-amber/15" onClick={() => updateSettings({ advanced: { developerMode: true } })}>Enable Developer Mode</button>
                    </div>
                  </div>
                </NotificationCard>
              ) : <>
                <div className="settings-rows">
                  <ActionRow label="Tab DevTools" help="Inspect the active webview.">
                    <VastButton variant="secondary" size="sm" onClick={runtime.toggleDevTools}><Code2 className="h-4 w-4" />Open</VastButton>
                  </ActionRow>
                  <ActionRow label="Reload active webview">
                    <VastButton variant="secondary" size="sm" onClick={runtime.reload}><Activity className="h-4 w-4" />Reload</VastButton>
                  </ActionRow>
                  <ActionRow label="Reload app chrome">
                    <VastButton variant="secondary" size="sm" onClick={() => window.location.reload()}><Activity className="h-4 w-4" />Reload</VastButton>
                  </ActionRow>
                  <ActionRow label="Debug report" help="Copy versions, platform, and active tab details.">
                    <VastButton variant="secondary" size="sm" onClick={() => void copyText(JSON.stringify({ appVersion, versions: window.vast.app.versions, platform: window.vast.app.platform, activeTab, activeWorkspace }, null, 2))}><FileDown className="h-4 w-4" />Copy</VastButton>
                  </ActionRow>
                  {diagnosticsState.available && (
                    <ActionRow label="Diagnostics">
                      <VastButton variant="secondary" size="sm" onClick={() => { runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL); setOpen(false) }}><Activity className="h-4 w-4" />Open</VastButton>
                    </ActionRow>
                  )}
                  <ActionRow label="Diagnostics summary" help="Copy state counts and runtime versions.">
                    <VastButton variant="secondary" size="sm" onClick={() => void copyText(JSON.stringify({ counts: { tabs: tabs.length, bookmarks: bookmarks.length, history: history.length, notes: notes.length, macros: macros.length }, versions: window.vast.app.versions }, null, 2))}><FileDown className="h-4 w-4" />Copy</VastButton>
                  </ActionRow>
                </div>
                <div className="settings-card mt-3">
                  <h3 className="settings-card-title">Runtime</h3>
                  <div className="grid gap-2 text-xs leading-5 text-vast-soft md:grid-cols-2">
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
                </div>
              </>}
            </section>

            <section id="Privacy" className="settings-section" hidden={!sectionVisible('Privacy')}>
              <div className="settings-page-head">
                <h2>Privacy</h2>
              </div>
              <div className="settings-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="settings-card-title mb-1">Vast Services</div>
                    <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-vast-soft">
                      Relay {relayStatusLabel}
                    </div>
                  </div>
                  <span className="rounded-control border border-white/10 px-2.5 py-1 text-[11px] text-vast-soft">No browsing telemetry</span>
                </div>
                <p className="mt-3 max-w-4xl text-xs leading-5 text-vast-soft">
                  Official public builds use production Vast Relay for signed service and update notices. A check-in sends a random installation ID, the Vast version, cumulative launch count, and instance kind; Relay derives first-seen and last-seen times. It does not receive browsing history, visited URLs, searches, tabs, bookmarks, page content, passwords, cookies, account identity, device fingerprints, session duration, or notice interaction events. Cloudflare may process request IPs ephemerally for transport security and rate limiting; Vast does not store them in the Relay database.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <VastButton variant="secondary" size="sm" onClick={() => { runtime.openUrlInNewTab('https://vastbrowser.com/privacy'); setOpen(false) }}><Shield className="h-4 w-4" />Privacy Notice</VastButton>
                  <VastButton variant="secondary" size="sm" onClick={() => { runtime.openUrlInNewTab('https://vastbrowser.com/support'); setOpen(false) }}><Activity className="h-4 w-4" />Support</VastButton>
                  <VastButton variant="secondary" size="sm" onClick={() => { runtime.openUrlInNewTab(INTERNAL_SITE_DATA_URL); setOpen(false) }}><Database className="h-4 w-4" />Review site data</VastButton>
                </div>
              </div>
              <div className="settings-rows mt-3.5">
                <ToggleRow
                  label="Block common trackers"
                  help="Filters known tracker requests before pages load."
                  checked={settings.privacy.blockTrackers}
                  onChange={(blockTrackers) => updateSettings({ privacy: { blockTrackers } })}
                />
                <ToggleRow
                  label="Clean tracking parameters while opening links"
                  help="Strips parameters such as utm_* from clicked links."
                  checked={settings.privacy.stripTrackingParameters}
                  onChange={(stripTrackingParameters) => updateSettings({ privacy: { stripTrackingParameters } })}
                />
                <ToggleRow label="Also remove affiliate parameters" checked={settings.privacy.stripAffiliateParameters} onChange={(stripAffiliateParameters) => updateSettings({ privacy: { stripAffiliateParameters } })} />
                <ToggleRow
                  label="Block third-party cookies"
                  help="Cookies set by other sites are dropped."
                  checked={settings.privacy.blockThirdPartyCookies}
                  onChange={(blockThirdPartyCookies) => updateSettings({ privacy: { blockThirdPartyCookies } })}
                />
                <ToggleRow
                  label="Fake browsing history"
                  help="Decoy history entries hide what you actually visited."
                  checked={settings.privacy.fakeHistoryEnabled}
                  onChange={(fakeHistoryEnabled) => updateSettings({ privacy: { fakeHistoryEnabled } })}
                />
                <ToggleRow
                  label="Clear cookies/site data on exit"
                  checked={settings.privacy.clearCookiesOnExit}
                  onChange={(clearCookiesOnExit) => updateSettings({ privacy: { clearCookiesOnExit } })}
                />
                <ToggleRow label="Make new workspaces temporary by default" checked={settings.privacy.privateWorkspaceDefault} onChange={(privateWorkspaceDefault) => updateSettings({ privacy: { privateWorkspaceDefault } })} />
                <ToggleRow label="Disable history globally" checked={settings.privacy.disableHistory} onChange={(disableHistory) => updateSettings({ privacy: { disableHistory } })} />
                <ToggleRow label="Disable recently closed tabs" checked={settings.privacy.disableRecentlyClosedTabs} onChange={(disableRecentlyClosedTabs) => updateSettings({ privacy: { disableRecentlyClosedTabs } })} />
                <ToggleRow label="Disable page text capture" checked={settings.privacy.disablePageTextCapture} onChange={(disablePageTextCapture) => updateSettings({ privacy: { disablePageTextCapture } })} />
                <ToggleRow label="Disable favicons" checked={settings.privacy.disableFavicons} onChange={(disableFavicons) => updateSettings({ privacy: { disableFavicons } })} />
                <SelectRow label="Fingerprinting" help="How aggressively fingerprint surfaces are masked or noised." value={settings.privacy.fingerprintingProtection} options={fingerprintingOptions} onChange={(value) => updateSettings({ privacy: { fingerprintingProtection: value } })} />
                <SelectRow label="WebRTC" help="Which network interfaces WebRTC may expose." value={settings.privacy.webRtcPolicy} options={webRtcOptions} onChange={(value) => updateSettings({ privacy: { webRtcPolicy: value } })} />
                <ActionRow label="WebRTC leak test">
                  <VastButton variant="secondary" size="sm" onClick={() => runtime.openUrlInNewTab('https://browserleaks.com/webrtc')}><Wifi className="h-4 w-4" />Open</VastButton>
                </ActionRow>
                <ActionRow label="Cookies and site data" help="Remove cookies and storage for all sites now.">
                  <VastButton variant="danger" size="sm" onClick={() => void window.vast.privacy.clearSiteData()}><Eraser className="h-4 w-4" />Clear</VastButton>
                </ActionRow>
                <StackedTextRow
                  label="Cookie/login exceptions (domains, comma-separated)"
                  help="These domains keep default login behavior."
                  value={settings.privacy.cookieExceptions.join(', ')}
                  onChange={(event) => updateSettings({ privacy: { cookieExceptions: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })}
                />
                <StackedTextRow
                  label="Fingerprinting exceptions (domains, comma-separated)"
                  value={settings.privacy.fingerprintingExceptions.join(', ')}
                  onChange={(event) => updateSettings({ privacy: { fingerprintingExceptions: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })}
                />
                <StackedTextRow
                  label="WebRTC exceptions (domains, comma-separated)"
                  value={settings.privacy.webRtcExceptions.join(', ')}
                  onChange={(event) => updateSettings({ privacy: { webRtcExceptions: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } })}
                />
              </div>
              <div className="mt-3.5 grid gap-3 md:grid-cols-2">
                <div className="settings-card p-3 text-sm"><div className="text-vast-soft">History</div><div className="mt-1 text-2xl font-semibold">{history.length}</div></div>
                <div className="settings-card p-3 text-sm"><div className="text-vast-soft">Downloads</div><div className="mt-1 text-2xl font-semibold">{downloads.length}</div></div>
              </div>
            </section>

            <section id="Spoofing" className="settings-section" hidden={!sectionVisible('Spoofing')}>
              <div className="settings-page-head">
                <div>
                  <h2>Spoofing</h2>
                  <p className="settings-page-sub">Best-effort privacy controls for requests, webviews, geolocation, and common fingerprint surfaces.</p>
                </div>
                <label className="settings-inline-toggle">
                  <span>Enabled</span>
                  <input
                    className="settings-switch"
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
              <div className="settings-rows">
                <SelectRow
                  label="Browser brand"
                  help="User agent and platform details pages read."
                  value={settings.spoofing.browserProfile}
                  options={spoofingProfiles}
                  onChange={(browserProfile) => updateSettings({ spoofing: { browserProfile } })}
                />
                <TextRow
                  label="Languages"
                  help="Language list reported to sites."
                  value={settings.spoofing.languages.join(', ')}
                  placeholder="en-US, en"
                  onChange={(event) => updateSettings({ spoofing: { languages: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })}
                />
                <SelectRow
                  label="Timezone"
                  value={settings.spoofing.timezone}
                  options={timezoneSelectOptions}
                  onChange={(timezone) => updateSettings({ spoofing: { timezone } })}
                />
                <ToggleRow label="Do Not Track" checked={settings.spoofing.doNotTrack} onChange={(doNotTrack) => updateSettings({ spoofing: { doNotTrack } })} />
                {settings.spoofing.browserProfile === 'custom' && (
                  <StackedTextRow
                    label="Custom user agent"
                    value={settings.spoofing.customUserAgent}
                    onChange={(event) => updateSettings({ spoofing: { customUserAgent: event.target.value } })}
                  />
                )}
                <TextRow label="CPU cores" help="CPU core count reported to scripts." type="number" min={2} max={32} value={settings.spoofing.hardwareConcurrency} onChange={(event) => updateSettings({ spoofing: { hardwareConcurrency: Number(event.target.value) } })} />
                <TextRow label="Device Memory GB" help="Device memory reported to scripts." type="number" min={1} max={32} value={settings.spoofing.deviceMemory} onChange={(event) => updateSettings({ spoofing: { deviceMemory: Number(event.target.value) } })} />
                <TextRow label="Touch points" help="Maximum touch points reported for input." type="number" min={0} max={10} value={settings.spoofing.maxTouchPoints} onChange={(event) => updateSettings({ spoofing: { maxTouchPoints: Number(event.target.value) } })} />
                <TextRow label="WebGL vendor" value={settings.spoofing.webglVendor} onChange={(event) => updateSettings({ spoofing: { webglVendor: event.target.value } })} />
                <TextRow label="WebGL renderer" value={settings.spoofing.webglRenderer} onChange={(event) => updateSettings({ spoofing: { webglRenderer: event.target.value } })} />
                <SelectRow
                  label="Location"
                  value={settings.spoofing.location.mode}
                  options={spoofingLocationOptions}
                  onChange={(mode) => updateSettings({ spoofing: { location: { mode } } })}
                />
                <TextRow label="Latitude" type="number" step="0.000001" min={-90} max={90} value={settings.spoofing.location.latitude} onChange={(event) => updateSettings({ spoofing: { location: { latitude: Number(event.target.value) } } })} />
                <TextRow label="Longitude" type="number" step="0.000001" min={-180} max={180} value={settings.spoofing.location.longitude} onChange={(event) => updateSettings({ spoofing: { location: { longitude: Number(event.target.value) } } })} />
                <TextRow label="Accuracy meters" type="number" min={1} max={50000} value={settings.spoofing.location.accuracy} onChange={(event) => updateSettings({ spoofing: { location: { accuracy: Number(event.target.value) } } })} />
                <ActionRow label="Spoofing profile" help="Restore default identity values.">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    onClick={() => updateSettings({ spoofing: DEFAULT_SETTINGS.spoofing })}
                  >
                    <Fingerprint className="h-4 w-4" />
                    Reset
                  </VastButton>
                </ActionRow>
                <ActionRow label="Warsaw profile" help="Polish locale, timezone, and fixed location.">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (!spoofingState.available) {
                        setActiveSection('Labs')
                        return
                      }
                      updateSettings({ spoofing: { enabled: true, location: { mode: 'fixed', latitude: 52.2297, longitude: 21.0122, accuracy: 25 }, timezone: 'Europe/Warsaw', languages: ['pl-PL', 'pl', 'en-US'] } })
                    }}
                  >
                    <MapPin className="h-4 w-4" />
                    Apply
                  </VastButton>
                </ActionRow>
              </div>
            </section>

            <section id="Security" className="settings-section" hidden={!sectionVisible('Security')}>
              <div className="settings-page-head">
                <h2>Security</h2>
              </div>
              <div className="settings-rows">
                <ToggleRow
                  label="HTTPS-only mode"
                  help="Prefer encrypted connections for site requests."
                  checked={settings.security.httpsOnlyMode}
                  onChange={(httpsOnlyMode) => updateSettings({ security: { ...settings.security, httpsOnlyMode } })}
                />
                <ToggleRow
                  label="External link confirmation"
                  help="Ask before opening links that launch other apps."
                  checked={settings.security.confirmExternalLinks}
                  onChange={(confirmExternalLinks) => updateSettings({ security: { ...settings.security, confirmExternalLinks } })}
                />
                <ToggleRow label="Dangerous download warnings" checked={settings.security.warnDangerousDownloads} onChange={(warnDangerousDownloads) => updateSettings({ security: { ...settings.security, warnDangerousDownloads } })} />
                <ActionRow label="Security defaults" help="Restore the default security posture and clear per-site overrides.">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    onClick={() => updateSettings({ security: { ...settings.security, httpsOnlyMode: false, confirmExternalLinks: false, warnDangerousDownloads: true, sitePermissions: [] } })}
                  >
                    <Shield className="h-4 w-4" />
                    Reset
                  </VastButton>
                </ActionRow>
              </div>
            </section>

            <section id="Site Data" className="settings-section" hidden={!sectionVisible('Site Data')}>
              <div className="settings-page-head">
                <h2>Site Data / Permissions</h2>
              </div>
              <div className="settings-rows">
                <ActionRow label="Diagnostics & Site Data" help="Inspect storage and permissions per site.">
                  <VastButton variant="secondary" size="sm" onClick={() => runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL)}><Database className="h-4 w-4" />Open</VastButton>
                </ActionRow>
                <ActionRow label="Cached site data" help="Remove caches and storage kept for sites.">
                  <VastButton variant="secondary" size="sm" onClick={() => void window.vast.privacy.clearSiteData()}><Eraser className="h-4 w-4" />Clear</VastButton>
                </ActionRow>
                <SelectRow label="Camera" help="Default permission sites receive for the camera." value={settings.security.permissionCamera} onChange={(permissionCamera: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionCamera } })} options={permissionOptions} />
                <SelectRow label="Microphone" value={settings.security.permissionMicrophone} onChange={(permissionMicrophone: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionMicrophone } })} options={permissionOptions} />
                <SelectRow label="Location" value={settings.security.permissionLocation} onChange={(permissionLocation: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionLocation } })} options={permissionOptions} />
                <SelectRow label="Notifications" value={settings.security.permissionNotifications} onChange={(permissionNotifications: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionNotifications } })} options={permissionOptions} />
                <SelectRow label="Clipboard" value={settings.security.permissionClipboard} onChange={(permissionClipboard: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionClipboard } })} options={permissionOptions} />
                <SelectRow label="Fullscreen" value={settings.security.permissionFullscreen} onChange={(permissionFullscreen: PermissionSetting) => updateSettings({ security: { ...settings.security, permissionFullscreen } })} options={permissionOptions} />
              </div>
              <div className="settings-card mt-3.5">
                <h3 className="settings-card-title">Per-site permissions</h3>
                {(settings.security.sitePermissions ?? []).length === 0 ? (
                  <div className="text-xs leading-5 text-vast-soft">No per-site permission overrides saved.</div>
                ) : (
                  <div className="settings-rows">
                    {(settings.security.sitePermissions ?? []).map((item) => (
                      <div key={`${item.origin}-${item.workspaceId ?? 'shared'}-${item.permission}`} className="settings-row">
                        <span className="settings-row-label min-w-0 truncate">
                          {item.origin} / {workspaces.find((workspace) => workspace.id === item.workspaceId)?.name ?? 'Shared'} / {item.permission}: <span className="font-semibold">{item.setting}</span>
                        </span>
                        <span className="settings-row-control">
                          <VastButton
                            variant="quiet"
                            size="sm"
                            onClick={() => updateSettings({ security: { ...settings.security, sitePermissions: (settings.security.sitePermissions ?? []).filter((override) => !(override.origin === item.origin && override.permission === item.permission && override.workspaceId === item.workspaceId)) } })}
                          >
                            Revoke
                          </VastButton>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section id="Search" className="settings-section" hidden={!sectionVisible('Search')}>
              <div className="settings-page-head">
                <h2>Search and Startup</h2>
              </div>
              <div className="settings-rows">
                <SelectRow
                  label="Search engine"
                  value={settings.defaultSearchEngine}
                  onChange={(defaultSearchEngine) => updateSettings({ defaultSearchEngine })}
                  options={SEARCH_ENGINES.map((engine) => ({ value: engine.id, label: engine.name }))}
                />
                <SelectRow
                  label="Startup"
                  help="What Vast shows when it launches."
                  value={settings.startupBehavior}
                  onChange={(startupBehavior) => updateSettings({ startupBehavior })}
                  options={[
                    { value: 'restore', label: 'Restore' },
                    { value: 'new-tab', label: 'New tab' },
                    { value: 'home', label: 'Home' }
                  ]}
                />
                <SelectRow
                  label="New tab layout"
                  help="Style of the page opened for new tabs."
                  value={settings.newTabBehavior}
                  onChange={(newTabBehavior) => updateSettings({ newTabBehavior })}
                  options={[
                    { value: 'vast', label: 'Dashboard' },
                    { value: 'search', label: 'Workspace focused' },
                    { value: 'blank', label: 'Minimalist' }
                  ]}
                />
                <ToggleRow label="Compact dashboard cards" checked={settings.newTab.compactCards} onChange={(compactCards) => updateSettings({ newTab: { compactCards } })} />
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
                  <ToggleRow key={key} label={`Show ${label.toLowerCase()}`} checked={settings.newTab[key]} onChange={(checked) => updateSettings({ newTab: { [key]: checked } })} />
                ))}
                <ToggleRow label="Restore previous session" checked={settings.restorePreviousSession} onChange={(restorePreviousSession) => updateSettings({ restorePreviousSession })} />
                <ToggleRow label="Hibernate inactive tabs" checked={settings.hibernateInactiveTabs} onChange={(hibernateInactiveTabs) => updateSettings({ hibernateInactiveTabs })} />
              </div>
              <div className="settings-default-browser-panel">
                <div className="settings-rows">
                  <ActionRow label="Default browser" help="Register Vast and pick it for web links in Windows.">
                    <VastButton
                      variant="secondary"
                      size="sm"
                      onClick={() => void openDefaultBrowserSetup()}
                      disabled={settingDefaultBrowser || defaultBrowserStatus?.supported === false}
                    >
                      <MonitorCheck className="h-4 w-4" />
                      <span>{settingDefaultBrowser ? 'Opening Windows Default Apps...' : 'set browser as default'}</span>
                    </VastButton>
                  </ActionRow>
                </div>
                <div className="settings-default-browser-note">
                  {defaultBrowserStatus?.supported === false
                    ? defaultBrowserStatus.message
                    : defaultBrowserMessage || 'Register Vast and open Windows Default Apps to select it for HTTP and HTTPS.'}
                </div>
              </div>
            </section>

            <section id="Automation" className="settings-section" hidden={!sectionVisible('Automation')}>
              <div className="settings-page-head">
                <h2>Automation</h2>
              </div>
              <div className="settings-rows">
                <ActionRow label="Macro manager" help="Create and review browser macros.">
                  <VastButton variant="secondary" size="sm" onClick={() => { runtime.openUrlInNewTab(INTERNAL_AUTOMATION_URL); setOpen(false) }}><Sparkles className="h-4 w-4" />Open</VastButton>
                </ActionRow>
                <ActionRow label="Run first macro">
                  <VastButton variant="secondary" size="sm" onClick={() => runtime.runMacro(macros[0]?.id ?? '')} disabled={!macros[0]}><Activity className="h-4 w-4" />Run</VastButton>
                </ActionRow>
                <MetaRow label="Macros installed" value={macros.length} />
                <MetaRow label="Automation model" value="Visible, local, user-controlled" />
              </div>
            </section>

            <section id="Workspaces" className="settings-section" hidden={!sectionVisible('Workspaces')}>
              <div className="settings-page-head">
                <h2>Workspaces</h2>
                <div className="settings-page-actions">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      openPromptDialog({
                        title: 'New workspace',
                        label: 'Workspace name',
                        placeholder: 'Research, Travel, Side project',
                        confirmLabel: 'Create workspace',
                        onConfirm: (name) => createWorkspace(name, settings.accentColor, settings.privacy.privateWorkspaceDefault)
                      })
                    }
                  >
                    <Plus className="h-4 w-4" />
                    New workspace
                  </VastButton>
                </div>
              </div>
              <div className="settings-stack">
                {workspaces.map((workspace) => (
                  <div key={workspace.id} className="settings-card" data-workspace-settings-id={workspace.id}>
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control" style={{ backgroundColor: `${workspace.color}22`, color: workspace.color }}>
                        <WorkspaceIcon name={workspace.icon} className="h-4 w-4" />
                      </span>
                      <input
                        value={workspace.name}
                        aria-label={`Rename ${workspace.name} workspace`}
                        onChange={(event) => renameWorkspace(workspace.id, event.target.value)}
                        className="min-w-0 flex-1 rounded-control border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-white outline-none transition hover:border-white/10 focus:border-vast-cyan/40"
                      />
                      <IconButton
                        variant={workspaceAppearanceId === workspace.id ? 'selected' : 'quiet'}
                        size="sm"
                        className="h-9 w-9 shrink-0"
                        tooltip={`Customize ${workspace.name} workspace`}
                        aria-label={`Customize ${workspace.name} workspace`}
                        aria-expanded={workspaceAppearanceId === workspace.id}
                        onClick={() => setWorkspaceAppearanceId((current) => current === workspace.id ? null : workspace.id)}
                      >
                        <Palette className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        variant="quiet"
                        size="sm"
                        className="h-9 w-9 shrink-0"
                        tooltip={`Delete ${workspace.name} workspace`}
                        aria-label={`Delete ${workspace.name} workspace`}
                        disabled={workspaces.length <= 1}
                        onClick={() => deleteWorkspace(workspace.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
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
                    <div className="settings-rows mt-3">
                      <SelectRow
                        label="Identity"
                        value={workspace.identity?.sessionMode ?? (workspace.isPrivate ? 'ephemeral' : 'isolated')}
                        options={workspaceSessionOptions}
                        onChange={(sessionMode) => updateWorkspaceIdentity(workspace.id, { sessionMode })}
                      />
                      <SelectRow
                        label="Network route"
                        value={workspace.identity?.proxyMode ?? 'system'}
                        options={workspaceProxyOptions}
                        onChange={(proxyMode) => updateWorkspaceIdentity(workspace.id, { proxyMode })}
                      />
                      {(workspace.identity?.proxyMode ?? 'system') === 'fixed' && <>
                        <TextRow
                          label="Proxy URL"
                          placeholder="socks5://127.0.0.1:9050"
                          value={workspace.identity?.proxyServer ?? ''}
                          onChange={(event) => updateWorkspaceIdentity(workspace.id, { proxyServer: event.target.value.slice(0, 2_048) })}
                        />
                        <TextRow
                          label="Proxy bypass rules"
                          placeholder="&lt;local&gt;"
                          value={workspace.identity?.proxyBypassRules ?? '<local>'}
                          onChange={(event) => updateWorkspaceIdentity(workspace.id, { proxyBypassRules: event.target.value.slice(0, 2_048) })}
                        />
                      </>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section id="Shortcuts" className="settings-section" hidden={!sectionVisible('Shortcuts')}>
              <div className="settings-page-head">
                <div>
                  <h2>Keyboard Shortcuts</h2>
                  <p className="settings-page-sub">Shortcuts are validated before they are applied.</p>
                </div>
                <div className="settings-page-actions">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setShortcutDrafts(DEFAULT_SHORTCUTS)
                      updateSettings({ keyboardShortcuts: DEFAULT_SHORTCUTS })
                    }}
                  >
                    Reset shortcuts
                  </VastButton>
                </div>
              </div>
              <div className="settings-rows">
                {Object.entries(shortcutDrafts).map(([name, shortcut]) => {
                  const error = shortcutErrors[name]
                  return (
                    <div key={name} className="settings-row">
                      <span className="settings-row-label">
                        {name}
                        {error && <span className="settings-row-sub text-vast-amber">{error}</span>}
                      </span>
                      <span className="settings-row-control">
                        <input
                          value={shortcut}
                          aria-label={`Edit ${name} shortcut`}
                          onChange={(event) => setShortcutDrafts((drafts) => ({ ...drafts, [name]: event.target.value }))}
                          onBlur={() => {
                            const next = shortcutDrafts[name]?.trim()
                            if (next && !shortcutErrors[name]) updateSettings({ keyboardShortcuts: { [name]: next } })
                          }}
                          className="w-36 text-center"
                        />
                        <VastButton
                          variant="ghost"
                          size="sm"
                          className="w-9 min-w-0 px-0"
                          title={`Reset ${name}`}
                          aria-label={`Reset ${name}`}
                          onClick={() => {
                            const next = DEFAULT_SHORTCUTS[name] ?? settings.keyboardShortcuts[name]
                            setShortcutDrafts((drafts) => ({ ...drafts, [name]: next }))
                            updateSettings({ keyboardShortcuts: { [name]: next } })
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </VastButton>
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>

            <section id="Data" className="settings-section" hidden={!sectionVisible('Data')}>
              <div className="settings-page-head">
                <h2>Data</h2>
              </div>
              <div className="settings-card">
                <div className="mb-3 text-sm font-semibold text-white">Current Vast data directory</div>
                <div className="break-all rounded-control border border-white/[0.08] bg-black/20 px-3 py-2 text-xs text-vast-soft">
                  {dataPathInfo?.currentDataPath ?? 'Loading...'}
                </div>
                <div className="mt-2 text-xs leading-5 text-vast-soft">
                  {dataPathInfo?.customDataPathActive
                    ? 'A custom data directory is active. The updater preserves this location.'
                    : 'Using the default Vast profile directory. App files and user data are kept separate.'}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    disabled={dataActionBusy === 'open'}
                    onClick={() => void runDataAction('open', async () => {
                      const result = await window.vast.dataPath.openDataFolder()
                      return result.ok ? { ok: true, warnings: ['Opened current Vast data directory.'] } : result
                    })}
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open data folder
                  </VastButton>
                  <VastButton
                    variant="secondary"
                    size="sm"
                    disabled={dataActionBusy === 'change'}
                    onClick={() => void runDataAction('change', () => window.vast.dataPath.changeDataDirectory())}
                  >
                    <Database className="h-4 w-4" />
                    Change Vast data directory
                  </VastButton>
                </div>
              </div>
              <div className="settings-rows mt-3.5">
                <ActionRow label="Browsing history" help="Remove saved history entries.">
                  <VastButton variant="danger" size="sm" onClick={clearHistory}>
                    <Trash2 className="h-4 w-4" />
                    Clear history
                  </VastButton>
                </ActionRow>
                <ActionRow label="Session timeline" help="Review browsing activity over time.">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)
                      setOpen(false)
                    }}
                  >
                    <History className="h-4 w-4" />
                    Open
                  </VastButton>
                </ActionRow>
                <ActionRow label="Full backup" help="Export every section of your Vast profile.">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    disabled={dataActionBusy === 'export'}
                    onClick={() => void runDataAction('export', exportFullBackupFromSettings)}
                  >
                    <FileDown className="h-4 w-4" />
                    Export all Vast data
                  </VastButton>
                </ActionRow>
                <ActionRow label="Restore backup" help="Import a previously exported Vast backup.">
                  <VastButton
                    variant="secondary"
                    size="sm"
                    disabled={dataActionBusy === 'import'}
                    onClick={() => void runDataAction('import', () => window.vast.storage.importFullBackup())}
                  >
                    <FileUp className="h-4 w-4" />
                    Import Vast data
                  </VastButton>
                </ActionRow>
              </div>
              {(dataMessage || migrationReport) && (
                <div className="settings-card mt-3.5 text-xs leading-5 text-vast-soft">
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
