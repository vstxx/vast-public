import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  ChevronsUpDown,
  Database,
  Cookie,
  EyeOff,
  FileText,
  Gauge,
  History,
  KeyRound,
  Lock,
  Minus,
  MoreHorizontal,
  Paintbrush,
  PanelRightOpen,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Wifi,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_SESSION_TIMELINE_URL,
  SEARCH_ENGINES
} from '../../../shared/constants'
import { getFeatureState, VastFeatures, type FeatureState } from '../../../shared/feature-gates'
import type { BrowserSettings, SiteInformation } from '../../../shared/types'
import { isSiteOverrideDisabled, siteOverrideForUrl } from '../../../shared/site-overrides'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { displayUrl, getEffectiveTabUrl, hostnameFor, isInternalUrl, isLikelySearch, isSecureUrl, resolveAddressInput, searchShortcutHint } from '../../lib/url'
import { useBrowserStore, selectActiveTab } from '../../store/browser-store'
import { VideoAudioMark } from '../avidae/VideoAudioBrand'
import { Favicon } from '../ui/Favicon'
import { IconButton } from '../ui/IconButton'
import { notifyCatOmniboxBlur, notifyCatOmniboxFocus, notifyCatOmniboxInput } from '../../lib/cat-addon-events'

interface AddressSuggestion {
  type: 'Bookmark' | 'History' | 'Search'
  title: string
  url: string
  favicon?: string
}

function addressValueForTab(url: string): string {
  if (url === INTERNAL_NEW_TAB_URL) return ''
  return getEffectiveTabUrl(url)
}

export function AddressBar({
  compact = false,
  variant = 'default',
  onFocusChange
}: {
  compact?: boolean
  showDeveloperTools?: boolean
  variant?: 'default' | 'purist'
  onFocusChange?: (focused: boolean) => void
}): JSX.Element {
  const runtime = useBrowserRuntime()
  const activeTab = useBrowserStore(selectActiveTab)
  const history = useBrowserStore((state) => state.history)
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const defaultSearchEngine = useBrowserStore((state) => state.settings.defaultSearchEngine)
  const labs = useBrowserStore((state) => state.settings.labs)
  const labsEnabled = labs.enabled
  const featureContextSettings = useMemo(() => ({ labs }) as BrowserSettings, [labs])
  const privacySettings = useBrowserStore((state) => state.settings.privacy)
  const siteOverrides = useBrowserStore((state) => state.settings.siteOverrides)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const forgetSite = useBrowserStore((state) => state.forgetSite)
  const setActiveSidePanel = useBrowserStore((state) => state.setActiveSidePanel)
  const sidePanelOpen = useBrowserStore((state) => state.sidePanelOpen)
  const setSidePanelOpen = useBrowserStore((state) => state.setSidePanelOpen)
  const setSettingsOpen = useBrowserStore((state) => state.setSettingsOpen)
  const setSmartUnloadOpen = useBrowserStore((state) => state.setSmartUnloadOpen)
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [siteInfoOpen, setSiteInfoOpen] = useState(false)
  const [siteInfo, setSiteInfo] = useState<SiteInformation | null>(null)
  const [siteInfoError, setSiteInfoError] = useState<string | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setValue(activeTab ? addressValueForTab(activeTab.url) : '')
  }, [activeTab?.id, activeTab?.url])

  useEffect(() => {
    if (!siteInfoOpen || !activeTab) return
    const url = getEffectiveTabUrl(activeTab.url)
    if (isInternalUrl(activeTab.url)) {
      setSiteInfo({
        kind: 'internal', url: activeTab.url, secure: false, certificateStatus: 'not-applicable', cookieCount: 0,
        serviceWorkerCount: 0,
        storage: { cookies: 0, localStorageEntries: 0, indexedDBDatabases: 0, serviceWorkers: 0 },
        permissions: [], blocked: { trackers: 0, ads: 0, malware: 0 }, interventionsDisabled: false
      })
      setSiteInfoError(null)
      return
    }
    const webContentsId = runtime.getActiveWebContentsId()
    if (!webContentsId) {
      setSiteInfo(null)
      setSiteInfoError('Page details are unavailable while this tab is sleeping or loading.')
      return
    }
    let cancelled = false
    setSiteInfo(null)
    setSiteInfoError(null)
    void window.vast.privacy.getSiteInformation(webContentsId, url).then((result) => {
      if (cancelled) return
      if (result.ok && result.info) setSiteInfo(result.info)
      else setSiteInfoError(result.error ?? 'Could not read site information.')
    })
    return () => { cancelled = true }
  }, [activeTab, runtime, siteInfoOpen])

  useEffect(() => {
    let frame: number | undefined
    const focus = (): void => {
      window.cancelAnimationFrame(frame ?? 0)
      frame = window.requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
    window.addEventListener('vast-focus-address', focus)
    return () => {
      window.cancelAnimationFrame(frame ?? 0)
      window.removeEventListener('vast-focus-address', focus)
    }
  }, [])

  const suggestions = useMemo(() => {
    const query = value.toLowerCase().trim()
    if (!focused || query.length < 1) return []
    const shortcut = searchShortcutHint(value)
    const matchedItems: AddressSuggestion[] = [
      ...bookmarks.map((item): AddressSuggestion => ({ type: 'Bookmark', title: item.title, url: item.url, favicon: item.favicon })),
      ...history.map((item): AddressSuggestion => ({ type: 'History', title: item.title, url: item.url, favicon: item.favicon }))
    ]
      .filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(query))
      .sort((a, b) => {
        const aExact = a.title.toLowerCase().startsWith(query) || a.url.toLowerCase().includes(query)
        const bExact = b.title.toLowerCase().startsWith(query) || b.url.toLowerCase().includes(query)
        return Number(bExact) - Number(aExact)
      })
      .slice(0, 6)

    if (isLikelySearch(value)) {
      const url = resolveAddressInput(value, defaultSearchEngine)
      matchedItems.unshift({
        type: 'Search',
        title: shortcut ? `Search ${shortcut.name}` : `Search ${SEARCH_ENGINES.find((engine) => engine.id === defaultSearchEngine)?.name ?? 'the web'}`,
        url
      })
    }
    return matchedItems
  }, [bookmarks, defaultSearchEngine, focused, history, value])

  useEffect(() => {
    setSelectedSuggestion(0)
  }, [value])

  const effectiveActiveUrl = activeTab ? getEffectiveTabUrl(activeTab.url) : undefined
  const activeTabUsesExternalSource = Boolean(activeTab && effectiveActiveUrl && effectiveActiveUrl !== activeTab.url)
  const activeSiteOverride = activeTab ? siteOverrideForUrl(effectiveActiveUrl ?? activeTab.url) : undefined
  const siteOverrideDisabled = Boolean(
    activeSiteOverride && isSiteOverrideDisabled(siteOverrides, activeSiteOverride.id)
  )
  const toggleSiteOverride = (): void => {
    if (!activeSiteOverride) return
    updateSettings({
      siteOverrides: {
        disabled: {
          [activeSiteOverride.id]: !siteOverrideDisabled
        }
      }
    })
  }

  const secure = activeTab ? isSecureUrl(activeTab.url) : true
  const isLoading = activeTab?.status === 'loading'
  const showLoadingProgress = Boolean(activeTab && (activeTab.status === 'loading' || activeTab.progress > 0))
  const loadingProgress = activeTab
    ? Math.min(1, Math.max(activeTab.status === 'loading' ? 0.08 : 0, activeTab.progress))
    : 0
  const isBookmarked = Boolean(
    activeTab &&
      effectiveActiveUrl &&
      !isInternalUrl(effectiveActiveUrl) &&
      bookmarks.some((bookmark) => bookmark.url === effectiveActiveUrl)
  )
  const featureStates = useMemo(
    () => ({
      avidae: getFeatureState(VastFeatures.Avidae, { settings: featureContextSettings }),
      automation: getFeatureState(VastFeatures.Automation, { settings: featureContextSettings }),
      networkDevices: getFeatureState(VastFeatures.NetworkDevices, { settings: featureContextSettings }),
      passwordManager: getFeatureState(VastFeatures.PasswordManager, { settings: featureContextSettings }),
      advancedDiagnostics: getFeatureState(VastFeatures.AdvancedDiagnostics, { settings: featureContextSettings }),
      sessionTimeline: getFeatureState(VastFeatures.SessionTimeline, { settings: featureContextSettings })
    }),
    [featureContextSettings]
  )
  const featureBadge = (state: FeatureState): string | undefined => {
    if (state.state === 'DisabledByFlag') return 'Off'
    if (state.state === 'ComingSoon') return 'Soon'
    return undefined
  }
  const activateFeatureAction = (state: FeatureState, action: () => void): void => {
    if (!state.available) {
      if (state.internalUrl) runtime.openUrlInNewTab(state.internalUrl)
      else setSettingsOpen(true)
      return
    }
    action()
  }

  return (
    <div className={`address-bar-row drag relative z-30 flex shrink-0 items-center px-4 ${variant === 'purist' ? 'address-bar-purist' : ''} ${compact ? 'h-[46px] gap-2' : 'h-[68px] gap-3'}`}>
      <div className={`address-bar-controls no-drag flex items-center gap-1 ${compact ? 'is-compact' : ''}`}>
        <IconButton tooltip="Back" disabled={!activeTab?.canGoBack} onClick={runtime.goBack}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <IconButton tooltip="Forward" disabled={!activeTab?.canGoForward} onClick={runtime.goForward}>
          <ArrowRight className="h-4 w-4" />
        </IconButton>
        <IconButton tooltip={isLoading ? 'Stop' : 'Reload'} onClick={isLoading ? runtime.stop : runtime.reload}>
          {isLoading ? <X className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
        </IconButton>
      </div>

      <form
        className="address-bar-form no-drag relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault()
          const suggestion = suggestions[selectedSuggestion]
          runtime.navigateActive(suggestion?.url ?? value)
          inputRef.current?.blur()
        }}
      >
        <div className={`vast-top-address group relative flex items-center gap-3 rounded-2xl px-4 backdrop-blur-xl transition duration-150 ${variant === 'purist' ? 'vast-top-address-purist' : ''} ${compact ? 'h-9' : 'h-12'}`}>
          {activeTab && <Favicon url={activeTab.url} favicon={activeTab.favicon} title={activeTab.title} />}
          <button
            type="button"
            title="Site information"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setSiteInfoOpen((value) => !value)}
            className="grid h-6 w-6 place-items-center rounded-lg text-vast-cyan transition hover:bg-white/10"
          >
            {secure ? (
              <Lock className="h-3.5 w-3.5" aria-label="Secure connection" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 text-vast-amber" aria-label="Not secure or internal page" />
            )}
          </button>
          <input
            ref={inputRef}
            value={value}
            onFocus={() => {
              setFocused(true)
              onFocusChange?.(true)
              notifyCatOmniboxFocus()
            }}
            onBlur={() => {
              notifyCatOmniboxBlur()
              window.setTimeout(() => {
                setFocused(false)
                onFocusChange?.(false)
              }, 120)
            }}
            onChange={(event) => {
              setValue(event.target.value)
              if (!(event.nativeEvent as InputEvent).isComposing) notifyCatOmniboxInput(event.target.value)
            }}
            onCompositionEnd={(event) => notifyCatOmniboxInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && suggestions.length > 0) {
                event.preventDefault()
                setSelectedSuggestion((index) => Math.min(index + 1, suggestions.length - 1))
              } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                event.preventDefault()
                setSelectedSuggestion((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setValue(activeTab ? addressValueForTab(activeTab.url) : '')
                inputRef.current?.blur()
              }
            }}
            placeholder="Search or enter address"
            className={`address-bar-input min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none transition-colors duration-150 placeholder:text-vast-soft ${
              focused ? 'text-white' : 'text-white/45'
            }`}
          />
          <div className="flex items-center gap-2">
            {value && isLikelySearch(value) && (
              <span className="hidden rounded-lg bg-vast-cyan/10 px-2 py-1 text-[11px] font-medium text-vast-cyan md:inline">
                {searchShortcutHint(value)?.name ?? SEARCH_ENGINES.find((engine) => engine.id === defaultSearchEngine)?.name ?? 'Search'}
              </span>
            )}
            <ChevronsUpDown className="address-bar-disclosure h-3.5 w-3.5 text-white/30" />
          </div>
        </div>

        {suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-14 overflow-hidden rounded-2xl border border-white/10 bg-[#0c0d12]/[0.98] p-2 shadow-glass backdrop-blur-xl">
            {suggestions.map((item, index) => (
              <button
                type="button"
                key={`${item.type}-${item.url}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSelectedSuggestion(index)}
                onClick={() => {
                  runtime.navigateActive(item.url)
                  setFocused(false)
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
                  index === selectedSuggestion ? 'bg-white/[0.09]' : 'hover:bg-white/[0.07]'
                }`}
              >
                {item.type === 'Search' ? <Search className="h-4 w-4 text-vast-cyan" /> : <Favicon url={item.url} favicon={item.favicon} title={item.title} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white">{item.title}</div>
                  <div className="truncate text-xs text-vast-soft">{displayUrl(item.url)}</div>
                </div>
                <span className="text-[11px] text-vast-soft">{item.type}</span>
              </button>
            ))}
          </div>
        )}
        {siteInfoOpen && activeTab && (
          <div className="absolute left-0 top-14 z-40 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-[#0c0d12]/[0.98] p-3 text-sm text-white shadow-glass backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <div className={`grid h-9 w-9 place-items-center rounded-xl ${siteInfo?.secure ? 'bg-vast-cyan/10 text-vast-cyan' : siteInfo?.kind === 'internal' ? 'bg-white/[0.07] text-vast-soft' : 'bg-vast-amber/10 text-vast-amber'}`}>
                {siteInfo?.secure ? <Lock className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{siteInfo?.kind === 'internal' ? 'Vast internal page' : siteInfo?.secure ? 'Secure connection' : siteInfo ? 'Connection is not secure' : 'Loading site information…'}</div>
                <div className="mt-1 truncate text-[13px] text-vast-soft">{siteInfo?.origin ?? (activeTabUsesExternalSource ? hostnameFor(effectiveActiveUrl ?? '') : isInternalUrl(activeTab.url) ? activeTab.url : hostnameFor(activeTab.url))}</div>
              </div>
            </div>
            {siteInfoError && <div className="mt-3 rounded-xl border border-vast-amber/20 bg-vast-amber/10 p-3 text-[13px] leading-5 text-vast-amber">{siteInfoError}</div>}
            {siteInfo && <div className="mt-3 space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.035] p-3 text-[13px] leading-5 text-vast-soft">
              <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Certificate</span><span className="text-right text-white">{siteInfo.certificateStatus === 'validated-by-chromium' ? 'Validated by Chromium' : siteInfo.certificateStatus === 'not-applicable' ? 'Not applicable' : 'Not secure'}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Cookie className="h-4 w-4" />Cookies</span><span className="text-white">{siteInfo.cookieCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span>localStorage entries</span><span className="text-white">{siteInfo.storage.localStorageEntries}</span></div>
              <div className="flex items-center justify-between gap-3"><span>IndexedDB databases</span><span className="text-white">{siteInfo.storage.indexedDBDatabases}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Service workers</span><span className="text-white">{siteInfo.serviceWorkerCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Permissions</span><span className="text-white">{siteInfo.permissions.length || 'Default'}</span></div>
              {siteInfo.kind === 'web' && <div className="flex items-center justify-between gap-3"><span>Blocked requests</span><span className="text-white">{siteInfo.blocked.trackers} trackers · {siteInfo.blocked.ads} ads · {siteInfo.blocked.malware} malware</span></div>}
              {siteInfo.permissions.map((permission) => <div key={`${permission.origin}-${permission.workspaceId ?? 'shared'}-${permission.permission}`} className="flex items-center justify-between gap-3 pl-6"><span className="capitalize">{permission.permission}</span><span className="capitalize text-white">{permission.setting}</span></div>)}
            </div>}
            {siteInfo?.kind === 'web' && siteInfo.origin && <label className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 text-[13px] text-vast-soft">
              <span>Disable Vast interventions for this site</span>
              <input
                type="checkbox"
                checked={privacySettings.siteInterventionsDisabled.includes(siteInfo.origin)}
                onChange={(event) => updateSettings({ privacy: { siteInterventionsDisabled: event.target.checked ? [...privacySettings.siteInterventionsDisabled.filter((origin) => origin !== siteInfo.origin), siteInfo.origin!] : privacySettings.siteInterventionsDisabled.filter((origin) => origin !== siteInfo.origin) } })}
              />
            </label>}
            {siteInfo?.kind === 'web' && siteInfo.hostname && <label className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 text-[13px] text-vast-soft">
              <span>Allow ads and trackers on this domain</span>
              <input
                type="checkbox"
                checked={privacySettings.adBlockAllowlist.includes(siteInfo.hostname)}
                onChange={(event) => updateSettings({ privacy: { adBlockAllowlist: event.target.checked ? [...privacySettings.adBlockAllowlist.filter((host) => host !== siteInfo.hostname), siteInfo.hostname!] : privacySettings.adBlockAllowlist.filter((host) => host !== siteInfo.hostname) } })}
              />
            </label>}
            {siteInfo?.kind === 'web' && siteInfo.hostname && <label className="mt-2 flex min-h-10 items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 text-[13px] text-vast-soft">
              <span>Clear data when its last tab closes</span>
              <input
                type="checkbox"
                checked={privacySettings.clearSiteDataOnClose.includes(siteInfo.hostname)}
                onChange={(event) => updateSettings({ privacy: { clearSiteDataOnClose: event.target.checked ? [...privacySettings.clearSiteDataOnClose.filter((host) => host !== siteInfo.hostname), siteInfo.hostname!] : privacySettings.clearSiteDataOnClose.filter((host) => host !== siteInfo.hostname) } })}
              />
            </label>}
            {siteInfo?.kind === 'web' && siteInfo.origin && (
              <button
                type="button"
                onClick={() => {
                  setSiteInfoOpen(false)
                  void window.vast.privacy.clearSiteData(siteInfo.origin, runtime.getActiveWebContentsId())
                }}
                className="mt-2 flex h-10 w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.045] text-[13px] font-semibold text-white hover:bg-white/[0.08]"
              >
                Clear cookies and storage for this site
              </button>
            )}
            {siteInfo?.kind === 'web' && siteInfo.origin && (
              <button
                type="button"
                onClick={() => {
                  setSiteInfoOpen(false)
                  void window.vast.privacy.clearSiteData(siteInfo.origin, runtime.getActiveWebContentsId()).finally(() => forgetSite(siteInfo.origin!))
                }}
                className="mt-2 flex h-10 w-full items-center justify-center rounded-xl border border-red-400/20 bg-red-400/[0.06] text-[13px] font-semibold text-red-200 hover:bg-red-400/[0.1]"
              >
                Forget this site
              </button>
            )}
          </div>
        )}
      </form>

      <div className={`address-bar-controls no-drag flex items-center gap-1 ${compact ? 'is-compact' : ''}`}>
        {activeSiteOverride && (
          <IconButton
            tooltip={siteOverrideDisabled ? 'Enable IDU skin' : 'Disable IDU skin'}
            active={!siteOverrideDisabled}
            aria-pressed={!siteOverrideDisabled}
            className={siteOverrideDisabled ? 'text-white/35' : undefined}
            onClick={toggleSiteOverride}
          >
            <Paintbrush className="h-4 w-4" />
          </IconButton>
        )}
        {labsEnabled && activeTab?.loginFormDetected && (
          <IconButton
            tooltip={featureStates.passwordManager.available ? 'Fill login' : 'Enable Password Manager in Labs'}
            onClick={() => activateFeatureAction(featureStates.passwordManager, () => void runtime.fillLoginForActive())}
          >
            <KeyRound className="h-4 w-4" />
          </IconButton>
        )}
        <IconButton tooltip={isBookmarked ? 'Remove bookmark' : 'Bookmark page'} active={isBookmarked} onClick={runtime.addCurrentBookmark}>
          <Star className="h-4 w-4" fill={isBookmarked ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton
          tooltip={sidePanelOpen ? 'Hide sidebar' : 'Show sidebar'}
          active={sidePanelOpen}
          onClick={() => {
            if (sidePanelOpen) setSidePanelOpen(false)
            else setActiveSidePanel('notes')
          }}
        >
          <PanelRightOpen className={`h-4 w-4 transition-transform duration-150 ${sidePanelOpen ? 'rotate-180' : ''}`} />
        </IconButton>
        <div className="relative">
          <IconButton tooltip="More browser tools" active={overflowOpen} onClick={() => setOverflowOpen((value) => !value)}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
          {overflowOpen && (
            <div className="browser-tools-menu absolute right-0 top-11 z-40 max-h-[72vh] w-64 overflow-y-auto rounded-2xl border border-white/10 bg-[#0c0d12]/[0.98] p-2 shadow-glass backdrop-blur-xl">
              <OverflowAction label="Incognito window" icon={EyeOff} onClick={runtime.openIncognitoWindow} onClose={() => setOverflowOpen(false)} />
              {labsEnabled && <>
                <OverflowAction label="Video & Audio" icon={VideoAudioMark} badge={featureBadge(featureStates.avidae)} unavailable={!featureStates.avidae.available} onClick={() => runtime.openUrlInNewTab(INTERNAL_AVIDAE_URL)} onClose={() => setOverflowOpen(false)} />
                <OverflowAction label="Automation" icon={Sparkles} badge={featureBadge(featureStates.automation)} unavailable={!featureStates.automation.available} onClick={() => runtime.openUrlInNewTab(INTERNAL_AUTOMATION_URL)} onClose={() => setOverflowOpen(false)} />
                <OverflowAction label="Network Devices" icon={Wifi} badge={featureBadge(featureStates.networkDevices)} unavailable={!featureStates.networkDevices.available} onClick={() => runtime.openUrlInNewTab(INTERNAL_NETWORK_URL)} onClose={() => setOverflowOpen(false)} />
              </>}
              <OverflowAction label="Notes" icon={FileText} onClick={() => runtime.openUrlInNewTab(INTERNAL_NOTES_URL)} onClose={() => setOverflowOpen(false)} />
              {labsEnabled && <>
                <OverflowAction label="Password Manager" icon={KeyRound} badge={featureBadge(featureStates.passwordManager)} unavailable={!featureStates.passwordManager.available} onClick={() => runtime.openUrlInNewTab(INTERNAL_PASSWORDS_URL)} onClose={() => setOverflowOpen(false)} />
                <OverflowAction label="Diagnostics & Site Data" icon={Database} badge={featureBadge(featureStates.advancedDiagnostics)} unavailable={!featureStates.advancedDiagnostics.available} onClick={() => runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL)} onClose={() => setOverflowOpen(false)} />
              </>}
              <OverflowAction label="Session Timeline" icon={History} badge={featureBadge(featureStates.sessionTimeline)} unavailable={!featureStates.sessionTimeline.available} onClick={() => runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)} onClose={() => setOverflowOpen(false)} />
              {labsEnabled && <>
                <OverflowAction label="Fill login" icon={KeyRound} badge={featureBadge(featureStates.passwordManager)} unavailable={!featureStates.passwordManager.available} disabled={!activeTab?.loginFormDetected} onClick={() => activateFeatureAction(featureStates.passwordManager, () => void runtime.fillLoginForActive())} onClose={() => setOverflowOpen(false)} />
                <OverflowAction label="Save password" icon={Lock} badge={featureBadge(featureStates.passwordManager)} unavailable={!featureStates.passwordManager.available} disabled={!activeTab?.loginFormDetected} onClick={() => activateFeatureAction(featureStates.passwordManager, () => void runtime.saveLoginForActive())} onClose={() => setOverflowOpen(false)} />
              </>}
              <OverflowAction label="Find in page" icon={Search} onClick={runtime.openFindUi} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Print page" icon={Printer} onClick={() => void runtime.printActive()} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Smart unload" icon={Gauge} onClick={() => setSmartUnloadOpen(true)} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Zoom out" icon={Minus} onClick={runtime.zoomOut} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Zoom in" icon={Plus} onClick={runtime.zoomIn} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Reset zoom" icon={ChevronsUpDown} onClick={runtime.resetZoom} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Save to reading list" icon={Bookmark} onClick={runtime.saveCurrentToReadingList} onClose={() => setOverflowOpen(false)} />
              <OverflowAction label="Settings" icon={Settings} onClick={() => setSettingsOpen(true)} onClose={() => setOverflowOpen(false)} />
            </div>
          )}
        </div>
      </div>

      <div className="address-bar-divider pointer-events-none absolute bottom-0 left-0 right-0" />
      {showLoadingProgress && (
        <div
          className="address-loading-progress absolute bottom-0 left-0 right-0 h-px origin-left bg-vast-cyan/90 shadow-[0_0_10px_rgba(116,231,255,0.55)] transition-transform duration-200"
          style={{ transform: `scaleX(${loadingProgress})` }}
        />
      )}
    </div>
  )
}

function OverflowAction({
  label,
  icon: Icon,
  onClick,
  onClose,
  disabled = false,
  unavailable = false,
  badge
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  onClick: () => void
  onClose: () => void
  disabled?: boolean
  unavailable?: boolean
  badge?: string
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        onClick()
        onClose()
      }}
      className={`browser-tools-action flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-vast-soft transition hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-vast-soft ${unavailable ? 'opacity-75' : ''}`}
    >
      <Icon className="h-4 w-4 text-vast-cyan" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge && (
        <span className="rounded-md border border-vast-cyan/20 bg-vast-cyan/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-vast-cyan">
          {badge}
        </span>
      )}
    </button>
  )
}
