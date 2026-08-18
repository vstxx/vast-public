import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { INTERNAL_AUTOMATION_URL, INTERNAL_NEW_TAB_URL } from '../../shared/constants'
import { getFeatureState, VastFeatures } from '../../shared/feature-gates'
import { resolveLayoutMode } from '../../shared/layout-mode'
import { mouseNavigationActionForButton, shouldTriggerMouseNavigation } from '../../shared/mouse-navigation'
import { isOpeningAnimationEnabled, normalizeOpeningSoundVolume } from '../../shared/opening-startup'
import { normalizeShortcutKey, parseShortcut } from '../../shared/shortcuts'
import { shouldAutoDismissNotification } from '../../shared/notification-lifetime'
import { isSensitiveAutomationUrl, macroActionUrl, macroContainsSensitiveTarget } from '../../shared/automation-policy'
import type {
  BrowserSettings,
  DetachedTabPayload,
  DownloadItem,
  ID,
  MacroAction,
  PersistedData,
  UiNotificationPayload,
  UiPromptPayload
} from '../../shared/types'
import vastLogo from '../../../assets/logos/vast.png'
import { OPENING_AUDIO, OPENING_SEQUENCE, openingVolumeToGain, toSeconds } from './opening-sequence'
import { OPENING_COMPLETE_MESSAGE } from '../../shared/opening-sequence'
import { AddressBar } from '../components/browser/AddressBar'
import type { BrowserStageHandle } from '../components/browser/BrowserStage'
import { FindBar } from '../components/browser/FindBar'
import { HorizontalChrome } from '../components/horizontal/HorizontalChrome'
import { Sidebar } from '../components/tabs/Sidebar'
import { ContextMenu } from '../components/ui/ContextMenu'
import { ActionPromptModal, NotificationsOverlay } from '../components/ui/NotificationsOverlay'
import { LocalErrorBoundary } from '../components/ui/LocalErrorBoundary'
import { PromptDialog } from '../components/ui/PromptDialog'
import { WindowControls } from '../components/window/WindowControls'
import { BrowserRuntimeContext, type BrowserRuntime } from './browser-runtime'
import { clamp } from '../lib/format'
import { handleBrowserTabOpenRequest } from '../lib/browser-tab-open'
import {
  createPdfViewerUrl,
  displayUrl,
  getEffectiveTabUrl,
  getPdfViewerReturnTo,
  getPdfViewerSource,
  isInternalUrl,
  isPdfViewerUrl,
  isSafeLoadUrl,
  looksLikePdfUrl,
  resolveAddressInput,
  titleFromUrl,
  webOriginFor
} from '../lib/url'
import { selectActiveTab, selectActiveWorkspace, useBrowserStore } from '../store/browser-store'
import { persistedStateChangeToken } from '../store/persisted-change'
import { isInactiveTabUnloadCandidate } from '../store/tab-lifecycle'

declare const __VAST_CAT_ADDON_AVAILABLE__: boolean

const CommandPalette = lazy(() => import('../components/command-palette/CommandPalette').then((module) => ({ default: module.CommandPalette })))
const loadPuristChrome = () => import('../components/purist/PuristChrome').then((module) => ({ default: module.PuristChrome }))
const PuristChrome = lazy(loadPuristChrome)
const CatAddonController = __VAST_CAT_ADDON_AVAILABLE__
  ? lazy(() => import('../components/cat-addon/CatAddonController').then((module) => ({ default: module.CatAddonController })))
  : null
const BrowserStage = lazy(() => import('../components/browser/BrowserStage').then((module) => ({ default: module.BrowserStage })))
const SettingsModal = lazy(() => import('../components/settings/SettingsModal').then((module) => ({ default: module.SettingsModal })))
const SidePanel = lazy(() => import('../components/side-panel/SidePanel').then((module) => ({ default: module.SidePanel })))
const SmartUnloadPanel = lazy(() => import('../components/browser/SmartUnloadPanel').then((module) => ({ default: module.SmartUnloadPanel })))
const RelayNoticeOverlay = lazy(() => import('../components/relay/RelayNoticeOverlay').then((module) => ({ default: module.RelayNoticeOverlay })))

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}

function getActiveTabSnapshot() {
  return selectActiveTab(useBrowserStore.getState())
}

function dispatchPdfCommand(type: string, tabId?: ID): boolean {
  const active = getActiveTabSnapshot()
  if (!active || !isPdfViewerUrl(active.url)) return false
  if (tabId && active.id !== tabId) return false
  window.dispatchEvent(new CustomEvent('vast-pdf-command', { detail: { type } }))
  return true
}

function appearanceStyle(settings: Pick<BrowserSettings, 'appearance' | 'accentColor'>): CSSProperties {
  const appearance = settings.appearance
  const radius = clamp(appearance.cornerRadius, 6, 36)
  const glass = clamp(appearance.glassIntensity, 0, 100)
  const blur = clamp(appearance.blurIntensity, 0, 100)
  const glow = clamp(appearance.glowIntensity, 0, 100)
  const border = clamp(appearance.borderIntensity, 0, 100)
  const shadow = clamp(appearance.shadowIntensity, 0, 100)
  const gradient = clamp(appearance.gradientIntensity, 0, 100)
  const panel = clamp(appearance.panelOpacity, 0, 100)
  const chrome = clamp(appearance.chromeOpacity, 0, 100)
  const saturation = clamp(appearance.saturation, 80, 145)

  return {
    '--vast-accent': settings.accentColor,
    '--vast-accent-secondary': appearance.secondaryAccentColor,
    '--vast-bg-tint': appearance.backgroundTintColor,
    '--vast-surface-tint': appearance.surfaceTintColor,
    '--vast-radius-control': `${Math.max(8, Math.round(radius * 0.54))}px`,
    '--vast-radius-checkbox': `${Math.max(6, Math.round(radius * 0.28))}px`,
    '--vast-radius-swatch': `${Math.max(7, Math.round(radius * 0.42))}px`,
    '--vast-radius-card': `${Math.round(radius)}px`,
    '--vast-radius-panel': `${Math.round(radius + 4)}px`,
    '--vast-radius-modal': `${Math.round(radius + 8)}px`,
    '--vast-blur': `${Math.round(8 + blur * 0.32)}px`,
    '--vast-saturation': `${(saturation / 100).toFixed(2)}`,
    '--vast-panel-mix': `${Math.round(68 + panel * 0.3)}%`,
    '--vast-address-panel-mix': `${Math.round(58 + panel * 0.28)}%`,
    '--vast-focus-panel-mix': `${Math.round(52 + panel * 0.26)}%`,
    '--vast-surface-mix': `${Math.round(34 + glass * 0.56)}%`,
    '--vast-border-mix': `${Math.round(10 + border * 0.62)}%`,
    '--vast-border-soft-mix': `${Math.round(7 + border * 0.42)}%`,
    '--vast-address-border-mix': `${Math.round(6 + border * 0.42)}%`,
    '--vast-focus-border-mix': `${Math.round(8 + border * 0.32)}%`,
    '--vast-glow-mix': `${Math.round(2 + glow * 0.32)}%`,
    '--vast-glow-soft-mix': `${Math.round(1 + glow * 0.14)}%`,
    '--vast-focus-glow-mix': `${Math.round(4 + glow * 0.36)}%`,
    '--vast-shadow-alpha': `${(0.08 + shadow * 0.0042).toFixed(3)}`,
    '--vast-address-shadow-alpha': `${(0.06 + shadow * 0.0032).toFixed(3)}`,
    '--vast-focus-shadow-alpha': `${(0.07 + shadow * 0.0037).toFixed(3)}`,
    '--vast-gradient-mix': `${Math.round(gradient * 0.22)}%`,
    '--vast-gradient-soft-mix': `${Math.round(gradient * 0.11)}%`,
    '--vast-gradient-strong-mix': `${Math.round(8 + gradient * 0.26)}%`,
    '--vast-chrome-alpha': `${(0.48 + chrome * 0.005).toFixed(3)}`,
    '--vast-chrome-mix': `${Math.round(48 + chrome * 0.5)}%`,
    '--vast-sheen-alpha': `${(0.014 + glass * 0.0007).toFixed(3)}`,
    '--vast-sheen-soft-alpha': `${(0.01 + glass * 0.00038).toFixed(3)}`
  } as CSSProperties
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = parseShortcut(shortcut)
  if (!parts) return false
  if (parts.ctrlOrMeta !== (event.ctrlKey || event.metaKey)) return false
  if (parts.shift !== event.shiftKey) return false
  if (parts.alt !== event.altKey) return false
  const eventKey = normalizeShortcutKey(event.key)
  return parts.key === eventKey || (parts.key === '+' && (eventKey === '=' || eventKey === '+'))
}

const OPENING_OVERLAY_STYLE = {
  '--vast-opening-duration': `${OPENING_SEQUENCE.totalMs}ms`
} as CSSProperties

type VastOpeningWindow = Window &
  typeof globalThis & {
    __vastOpeningStartupEnabled?: boolean
  }

function playOpeningSerenitySound(volume: number): () => void {
  const volumeGain = openingVolumeToGain(volume)
  if (volumeGain <= 0) return () => undefined

  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return () => undefined

  let closed = false
  const context = new AudioContextCtor()
  const now = context.currentTime
  const duration = toSeconds(OPENING_AUDIO.durationMs)
  const master = context.createGain()
  const compressor = context.createDynamicsCompressor()
  const toneBus = context.createGain()
  const filter = context.createBiquadFilter()
  const highpass = context.createBiquadFilter()
  const chorusDelay = context.createDelay()
  const chorusGain = context.createGain()
  const chorusLfo = context.createOscillator()
  const chorusDepth = context.createGain()
  const reverb = context.createConvolver()
  const dry = context.createGain()
  const wet = context.createGain()
  const toneStops: AudioScheduledSourceNode[] = []

  master.gain.setValueAtTime(0.0001, now)
  master.gain.exponentialRampToValueAtTime(0.052 * volumeGain, now + 0.68)
  master.gain.setTargetAtTime(0.068 * volumeGain, now + toSeconds(OPENING_AUDIO.masterPeakMs), 0.52)
  master.gain.setTargetAtTime(0.031 * volumeGain, now + toSeconds(OPENING_AUDIO.fadeOutStartMs), 0.42)
  master.gain.exponentialRampToValueAtTime(0.0001, now + duration)

  toneBus.gain.value = 0.96

  compressor.threshold.value = -24
  compressor.knee.value = 18
  compressor.ratio.value = 2.2
  compressor.attack.value = 0.16
  compressor.release.value = 0.78

  highpass.type = 'highpass'
  highpass.frequency.value = 76
  highpass.Q.value = 0.28

  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(820, now)
  filter.frequency.exponentialRampToValueAtTime(OPENING_AUDIO.filterPeakHz, now + toSeconds(OPENING_AUDIO.filterPeakMs))
  filter.frequency.exponentialRampToValueAtTime(OPENING_AUDIO.filterResolveHz, now + duration)
  filter.Q.value = 0.14

  chorusDelay.delayTime.value = 0.015
  chorusGain.gain.value = 0.17
  chorusLfo.type = 'sine'
  chorusLfo.frequency.value = 0.09
  chorusDepth.gain.value = 0.0038

  dry.gain.value = 0.8
  wet.gain.value = 0.18

  const impulseLength = Math.floor(context.sampleRate * 2.6)
  const impulse = context.createBuffer(2, impulseLength, context.sampleRate)
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel)
    for (let index = 0; index < impulseLength; index += 1) {
      const decay = Math.pow(1 - index / impulseLength, 3.2)
      data[index] = (Math.random() * 2 - 1) * decay * 0.045
    }
  }
  reverb.buffer = impulse

  toneBus.connect(highpass)
  highpass.connect(filter)
  filter.connect(dry)
  filter.connect(chorusDelay)
  chorusDelay.connect(chorusGain)
  chorusGain.connect(dry)
  filter.connect(reverb)
  reverb.connect(wet)
  dry.connect(compressor)
  wet.connect(compressor)
  compressor.connect(master)
  master.connect(context.destination)
  chorusLfo.connect(chorusDepth)
  chorusDepth.connect(chorusDelay.delayTime)
  chorusLfo.start(now)
  chorusLfo.stop(now + duration)
  toneStops.push(chorusLfo)

  const addVoice = (voice: (typeof OPENING_AUDIO.voices)[number]): void => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const startAt = now + toSeconds(voice.startMs)
    const peakAt = startAt + toSeconds(voice.attackMs)
    const releaseAt = now + toSeconds(voice.releaseMs)
    oscillator.type = voice.type ?? 'sine'
    oscillator.frequency.setValueAtTime(voice.frequency * 0.998, startAt)
    oscillator.frequency.exponentialRampToValueAtTime(voice.frequency, Math.min(peakAt + 0.22, releaseAt))
    oscillator.detune.value = voice.detune
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(voice.gain, peakAt)
    gain.gain.setTargetAtTime(voice.gain * 0.84, peakAt, 0.72)
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt)
    oscillator.connect(gain)
    gain.connect(toneBus)
    oscillator.start(startAt)
    oscillator.stop(now + duration)
    toneStops.push(oscillator)
  }

  const addBreath = (): void => {
    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let index = 0; index < data.length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * 0.011
    }
    const source = context.createBufferSource()
    const gain = context.createGain()
    const airFilter = context.createBiquadFilter()
    source.buffer = noiseBuffer
    source.loop = true
    airFilter.type = 'lowpass'
    airFilter.frequency.value = 480
    airFilter.Q.value = 0.12
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.012, now + toSeconds(OPENING_AUDIO.noisePeakMs))
    gain.gain.setTargetAtTime(0.008, now + toSeconds(OPENING_AUDIO.noiseFadeOutStartMs), 0.58)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    source.connect(airFilter)
    airFilter.connect(gain)
    gain.connect(filter)
    source.start(now)
    source.stop(now + duration)
    toneStops.push(source)
  }

  for (const voice of OPENING_AUDIO.voices) addVoice(voice)
  addBreath()

  void context.resume().catch(() => undefined)
  const closeTimer = window.setTimeout(() => {
    if (!closed) void context.close().catch(() => undefined)
    closed = true
  }, OPENING_AUDIO.durationMs + OPENING_AUDIO.closeBufferMs)

  return () => {
    window.clearTimeout(closeTimer)
    for (const source of toneStops) {
      try {
        source.stop()
      } catch {
        // Audio source may have already ended.
      }
    }
    if (!closed) void context.close().catch(() => undefined)
    closed = true
  }
}

function VastOpeningAnimation({ visible }: { visible: boolean }): JSX.Element | null {
  if (!visible) return null
  return (
    <div
      className="vast-opening-overlay pointer-events-none fixed inset-0 z-[80] grid place-items-center overflow-hidden bg-vast-black"
      style={{
        ...OPENING_OVERLAY_STYLE,
        '--vast-opening-delay': '0ms'
      } as CSSProperties}
    >
      <div className="vast-opening-backdrop" />
      <div className="vast-opening-core relative grid place-items-center">
        <div className="vast-opening-logo-halo" aria-hidden="true" />
        <span className="vast-opening-logo-frame relative">
          <img src={vastLogo} alt="Vast" draggable={false} decoding="async" className="vast-opening-logo select-none" />
        </span>
      </div>
    </div>
  )
}

function normalizeDetachedTabPayload(input: unknown): DetachedTabPayload | null {
  if (!input || typeof input !== 'object') return null
  const payload = input as Partial<DetachedTabPayload>
  if (typeof payload.url !== 'string' || !isSafeLoadUrl(payload.url)) return null
  return {
    url: payload.url,
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : undefined,
    favicon: typeof payload.favicon === 'string' && payload.favicon.trim() ? payload.favicon.trim() : undefined,
    muted: typeof payload.muted === 'boolean' ? payload.muted : undefined,
    zoom: typeof payload.zoom === 'number' && Number.isFinite(payload.zoom)
      ? Math.min(5, Math.max(0.25, payload.zoom))
      : undefined,
    sourceTabId: typeof payload.sourceTabId === 'string' && payload.sourceTabId.trim() ? payload.sourceTabId.trim() : undefined,
    sourceWorkspaceId: typeof payload.sourceWorkspaceId === 'string' && payload.sourceWorkspaceId.trim() ? payload.sourceWorkspaceId.trim() : undefined,
    sourceGroupId: typeof payload.sourceGroupId === 'string' && payload.sourceGroupId.trim() ? payload.sourceGroupId.trim() : undefined
  }
}

function parseDetachedStartupTab(search: string): DetachedTabPayload | null {
  const raw = new URLSearchParams(search).get('vastDetachedTab')
  if (!raw) return null
  try {
    return normalizeDetachedTabPayload(JSON.parse(raw))
  } catch {
    return null
  }
}

function buildDetachedTabData(data: PersistedData, detachedTab: DetachedTabPayload): PersistedData {
  const now = Date.now()
  const workspaceId = 'workspace-detached'
  const groupId = 'group-detached'
  const tabId = 'tab-detached'
  const isInternal = isInternalUrl(detachedTab.url)

  return {
    ...data,
    activeWorkspaceId: workspaceId,
    activeSidePanel: data.activeSidePanel,
    sidePanelOpen: false,
    focusMode: false,
    splitView: { enabled: false },
    workspaces: [
      {
        id: workspaceId,
        name: 'Detached',
        icon: 'Sparkles',
        color: data.settings.accentColor,
        order: 0,
        activeTabId: tabId,
        createdAt: now,
        updatedAt: now
      }
    ],
    tabGroups: [
      {
        id: groupId,
        workspaceId,
        name: 'Window',
        color: data.settings.accentColor,
        collapsed: false,
        order: 0
      }
    ],
    tabs: [
      {
        id: tabId,
        workspaceId,
        groupId,
        title: detachedTab.title || titleFromUrl(detachedTab.url),
        url: detachedTab.url,
        displayUrl: displayUrl(detachedTab.url),
        favicon: detachedTab.favicon,
        pinned: false,
        muted: detachedTab.muted,
        status: isInternal ? 'idle' : 'loading',
        lifecycle: 'active',
        progress: isInternal ? 0 : 0.12,
        canGoBack: false,
        canGoForward: false,
        zoom: detachedTab.zoom ?? 1,
        lastAccessedAt: now,
        createdAt: now
      }
    ],
    recentlyClosedTabs: [],
    sessionSnapshots: [],
    settings: {
      ...data.settings,
      startupBehavior: 'restore',
      restorePreviousSession: true
    }
  }
}

export function App(): JSX.Element {
  const stageRef = useRef<BrowserStageHandle | null>(null)
  const automationRunRef = useRef<{ macroId: ID; cancelled: boolean; startedAt: number } | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const startupOpeningEnabled = window.vast.app.startup.openingAnimationEnabled
  const startupOpeningHandledBySplash = window.vast.app.startup.openingAnimationHandledBySplash
  const detachedStartupTab = useMemo(() => parseDetachedStartupTab(window.location.search), [])
  const detachedWindow = Boolean(detachedStartupTab)
  const startupOpeningRunsInMain =
    startupOpeningEnabled && (window as VastOpeningWindow).__vastOpeningStartupEnabled === true
  const splashPlayedRef = useRef(startupOpeningEnabled || startupOpeningHandledBySplash)
  const splashTimerRef = useRef<number | undefined>(undefined)
  const splashSoundTimerRef = useRef<number | undefined>(undefined)
  const openingSoundCleanupRef = useRef<(() => void) | undefined>(undefined)
  const wheelZoomAccumulatorRef = useRef(0)
  const lastWheelZoomRef = useRef(0)
  const applyingSiteMemoryRef = useRef(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openingVisible, setOpeningVisible] = useState(startupOpeningEnabled)
  const [openingSoundActive, setOpeningSoundActive] = useState(startupOpeningEnabled)
  const [openingSoundVolume, setOpeningSoundVolume] = useState(() =>
    normalizeOpeningSoundVolume(window.vast.app.startup.openingAnimationSoundVolume)
  )
  const [htmlFullscreenSession, setHtmlFullscreenSession] = useState<{ tabId: ID; webContentsId: number } | null>(null)
  const hydrated = useBrowserStore((state) => state.hydrated)
  const focusMode = useBrowserStore((state) => state.focusMode)
  const accentColor = useBrowserStore((state) => state.settings.accentColor)
  const animations = useBrowserStore((state) => state.settings.animations)
  const appearance = useBrowserStore((state) => state.settings.appearance)
  const catAddonEnabled = useBrowserStore((state) => state.settings.catAddon.enabled)
  const experimentalFeatures = useBrowserStore((state) => state.settings.advanced.experimentalFeatures)
  const requestedSettingLayoutMode = useBrowserStore((state) => state.settings.layoutMode)
  const sidePanelMode = useBrowserStore((state) => state.settings.sidePanel.mode)
  const tabLayout = useBrowserStore((state) => state.settings.tabLayout)
  const theme = useBrowserStore((state) => state.settings.theme)
  const activeTabUrl = useBrowserStore((state) => selectActiveTab(state)?.url ?? '')
  const downloads = useBrowserStore((state) => state.downloads)
  const sidePanelOpen = useBrowserStore((state) => state.sidePanelOpen)
  const commandPaletteOpen = useBrowserStore((state) => state.commandPaletteOpen)
  const smartUnloadOpen = useBrowserStore((state) => state.smartUnloadOpen)
  const settingsOpen = useBrowserStore((state) => state.settingsOpen)
  const requestedLayoutMode = requestedSettingLayoutMode ?? (tabLayout === 'compact' ? 'horizontal' : 'vertical')
  const layoutMode = resolveLayoutMode(requestedLayoutMode, experimentalFeatures)
  const systemPrefersLight = useMediaQuery('(prefers-color-scheme: light)')
  const systemPrefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const narrowSidePanel = useMediaQuery('(max-width: 1300px)')
  const autoCollapseSidebar = useMediaQuery('(max-width: 1150px)')
  const constrainedGraphics = useMemo(() => {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return navigator.hardwareConcurrency <= 4 || (typeof memory === 'number' && memory <= 4)
  }, [])
  const resolvedTheme = theme === 'system' ? (systemPrefersLight ? 'light' : 'dark') : theme
  const sidebarPinned = sidePanelMode === 'overlay' || (sidePanelMode === 'auto' && narrowSidePanel)
  const showSidebar = !focusMode && !htmlFullscreenSession && layoutMode === 'vertical'
  const showHorizontalChrome = !focusMode && !htmlFullscreenSession && layoutMode === 'horizontal'
  const showPuristChrome = !focusMode && !htmlFullscreenSession && layoutMode === 'purist'
  const activeTabIsNewTab = activeTabUrl === INTERNAL_NEW_TAB_URL
  const visualStyle = useMemo(() => appearanceStyle({ appearance, accentColor }), [accentColor, appearance])
  const [toasts, setToasts] = useState<Array<UiNotificationPayload & { createdAt: number }>>([])
  const [uiPromptQueue, setUiPromptQueue] = useState<UiPromptPayload[]>([])
  const toastTimersRef = useRef<Record<string, number>>({})
  const downloadStateRef = useRef(new Map<string, DownloadItem['state']>())
  const autosaveTimerRef = useRef<number | undefined>(undefined)
  const lastSavedPayloadRef = useRef('')
  const pendingSavedPayloadRef = useRef<string | undefined>(undefined)
  const observedPersistedTokenRef = useRef('')
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const pushToastRef = useRef<(notification: Omit<UiNotificationPayload, 'id'> & { id?: string }) => void>(() => undefined)
  const queuePersistedSaveRef = useRef<(payload: PersistedData, serialized: string, reason: string) => void>(() => undefined)

  pushToastRef.current = (notification): void => {
    const id = notification.id ?? crypto.randomUUID()
    const durationMs =
      notification.durationMs ??
      (notification.tone === 'error' ? 12_000 : notification.tone === 'warning' ? 9_000 : 4_800)

    window.clearTimeout(toastTimersRef.current[id])
    delete toastTimersRef.current[id]
    if (shouldAutoDismissNotification(durationMs)) {
      toastTimersRef.current[id] = window.setTimeout(() => {
        window.clearTimeout(toastTimersRef.current[id])
        delete toastTimersRef.current[id]
        startTransition(() => setToasts((current) => current.filter((toast) => toast.id !== id)))
      }, durationMs)
    }

    startTransition(() =>
      setToasts((current) => [
        {
          ...notification,
          id,
          durationMs,
          createdAt: Date.now()
        },
        ...current.filter((toast) => toast.id !== id)
      ].slice(0, 6))
    )
  }

  const dismissToast = (id: string): void => {
    window.clearTimeout(toastTimersRef.current[id])
    delete toastTimersRef.current[id]
    startTransition(() => setToasts((current) => current.filter((toast) => toast.id !== id)))
  }

  queuePersistedSaveRef.current = (payload, serialized, reason): void => {
    const failureToastId = 'storage-autosave-failed'
    if (serialized === lastSavedPayloadRef.current) {
      dismissToast(failureToastId)
      return
    }
    if (serialized === pendingSavedPayloadRef.current) return
    pendingSavedPayloadRef.current = serialized
    const persist = reason === 'debounce' ? window.vast.storage.save : window.vast.storage.flush
    saveChainRef.current = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = await persist(payload)
        if (!result.ok) throw new Error('error' in result ? result.error : 'Storage save failed.')
        lastSavedPayloadRef.current = serialized
        dismissToast(failureToastId)
      })
      .catch((error) => {
        console.error(reason === 'debounce' ? '[storage] Save failed:' : '[storage] Flush failed:', error)
        pushToastRef.current({
          id: failureToastId,
          tone: 'error',
          title: 'Vast could not save changes',
          message: 'Your latest browser changes are still in memory. Retry the save before closing Vast.',
          detail: error instanceof Error ? error.message : String(error),
          durationMs: 0,
          actions: [{
            label: 'Retry',
            action: () => {
              dismissToast(failureToastId)
              const latestPayload = useBrowserStore.getState().toPersistedData()
              queuePersistedSaveRef.current(latestPayload, JSON.stringify(latestPayload), reason)
            }
          }]
        })
      })
      .finally(() => {
        if (pendingSavedPayloadRef.current === serialized) pendingSavedPayloadRef.current = undefined
      })
  }

  const flushPendingSave = useCallback(
    (reason = 'debounce'): void => {
      if (detachedWindow) return
      const state = useBrowserStore.getState()
      if (!state.hydrated) return

      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = undefined

      const payload = state.toPersistedData()
      const serialized = JSON.stringify(payload)
      if (serialized === lastSavedPayloadRef.current || serialized === pendingSavedPayloadRef.current) return

      queuePersistedSaveRef.current(payload, serialized, reason)
    },
    [detachedWindow]
  )

  const syncDetachedFinalTab = useCallback(
    (reason = 'beforeunload'): void => {
      if (!detachedWindow || !detachedStartupTab?.sourceTabId || !detachedStartupTab.sourceWorkspaceId) return
      const active = selectActiveTab(useBrowserStore.getState())
      if (!active) return
      void window.vast.browser.syncDetachedTab({
        url: active.url,
        title: active.title,
        favicon: active.favicon,
        muted: active.muted,
        zoom: active.zoom,
        sourceTabId: detachedStartupTab.sourceTabId,
        sourceWorkspaceId: detachedStartupTab.sourceWorkspaceId,
        sourceGroupId: detachedStartupTab.sourceGroupId
      }).catch((error) => console.warn(`[storage] Detached tab sync failed during ${reason}:`, error))
    },
    [detachedStartupTab, detachedWindow]
  )

  useEffect(() =>
    window.vast.browser.onPrepareClose(async (requestId) => {
      try {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = undefined

        if (detachedWindow) {
          const active = selectActiveTab(useBrowserStore.getState())
          if (active && detachedStartupTab?.sourceTabId && detachedStartupTab.sourceWorkspaceId) {
            const result = await window.vast.browser.syncDetachedTab({
              url: active.url,
              title: active.title,
              favicon: active.favicon,
              muted: active.muted,
              zoom: active.zoom,
              sourceTabId: detachedStartupTab.sourceTabId,
              sourceWorkspaceId: detachedStartupTab.sourceWorkspaceId,
              sourceGroupId: detachedStartupTab.sourceGroupId
            })
            if (!result.ok) throw new Error(result.error ?? 'Detached tab synchronization failed.')
          }
        } else {
          await saveChainRef.current.catch(() => undefined)
          const state = useBrowserStore.getState()
          if (state.hydrated) {
            const result = await window.vast.storage.flush(state.toPersistedData())
            if (!result.ok) throw new Error(result.error ?? 'Final storage flush failed.')
          }
        }
        void window.vast.browser.closeReady(requestId, { ok: true }).catch(() => undefined)
      } catch (error) {
        void window.vast.browser.closeReady(requestId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined)
      }
    }),
    [detachedStartupTab, detachedWindow]
  )

  const resolveUiPrompt = (prompt: UiPromptPayload, actionId: string): void => {
    startTransition(() => setUiPromptQueue((queue) => queue.filter((item) => item.id !== prompt.id)))
    void window.vast.ui.resolvePrompt(prompt.id, actionId).catch((error) => {
      console.warn('[ui] Failed to resolve prompt:', error)
    })
  }

  const activeUiPrompt = uiPromptQueue[0] ?? null

  useEffect(
    () => () => {
      for (const timer of Object.values(toastTimersRef.current)) {
        window.clearTimeout(timer)
      }
      toastTimersRef.current = {}
    },
    []
  )

  useEffect(
    () =>
      window.vast.browser.onDetachedTabReattach((input) => {
        const payload = normalizeDetachedTabPayload(input)
        if (!payload) return
        const state = useBrowserStore.getState()
        const sourceWorkspace = payload.sourceWorkspaceId
          ? state.workspaces.find((workspace) => workspace.id === payload.sourceWorkspaceId && !workspace.isPrivate)
          : undefined
        const workspaceId = sourceWorkspace?.id ?? state.activeWorkspaceId
        const groupId = payload.sourceGroupId && state.tabGroups.some((group) => group.id === payload.sourceGroupId && group.workspaceId === workspaceId)
          ? payload.sourceGroupId
          : undefined
        const routedUrl = looksLikePdfUrl(payload.url) ? createPdfViewerUrl(payload.url) : payload.url
        const tab = state.createTab({
          url: routedUrl,
          title: payload.title || titleFromUrl(routedUrl),
          workspaceId,
          groupId,
          activate: true
        })
        state.updateTab(tab.id, {
          favicon: payload.favicon,
          muted: payload.muted,
          zoom: payload.zoom ?? tab.zoom
        })
      }),
    []
  )

  useEffect(() => {
    let cancelled = false
    void window.vast.storage
      .load()
      .then(async (data) => {
        if (cancelled) return
        const startupData = detachedStartupTab ? buildDetachedTabData(data, detachedStartupTab) : data
        const startupLayout = resolveLayoutMode(
          startupData.settings.layoutMode ?? (startupData.settings.tabLayout === 'compact' ? 'horizontal' : 'vertical'),
          startupData.settings.advanced.experimentalFeatures
        )
        if (startupLayout === 'purist') await loadPuristChrome()
        if (cancelled) return
        const openingEnabled = !detachedWindow && isOpeningAnimationEnabled(startupData.settings)
        if (openingEnabled && !splashPlayedRef.current) {
          splashPlayedRef.current = true
          setOpeningVisible(true)
          setOpeningSoundActive(true)
        } else if (!openingEnabled) {
          setOpeningVisible(false)
          setOpeningSoundActive(false)
        }
        setOpeningSoundVolume(normalizeOpeningSoundVolume(startupData.settings.openingAnimationSoundVolume))
        useBrowserStore.getState().hydrate(startupData)
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)))
    return () => {
      cancelled = true
      window.clearTimeout(splashTimerRef.current)
      window.clearTimeout(splashSoundTimerRef.current)
    }
  }, [detachedStartupTab, detachedWindow])

  useEffect(() => {
    window.clearTimeout(splashTimerRef.current)
    if (!openingVisible) return
    const remainingMs = OPENING_SEQUENCE.overlayHideMs
    splashTimerRef.current = window.setTimeout(() => {
      if (startupOpeningRunsInMain) {
        window.postMessage({ type: OPENING_COMPLETE_MESSAGE }, '*')
        splashTimerRef.current = window.setTimeout(() => setOpeningVisible(false), 48)
        return
      }
      setOpeningVisible(false)
    }, remainingMs)
    return () => window.clearTimeout(splashTimerRef.current)
  }, [openingVisible, startupOpeningRunsInMain])

  useEffect(() => {
    window.clearTimeout(splashSoundTimerRef.current)
    if (!openingSoundActive) return
    const remainingMs = OPENING_SEQUENCE.overlayHideMs
    splashSoundTimerRef.current = window.setTimeout(() => setOpeningSoundActive(false), remainingMs)
    return () => window.clearTimeout(splashSoundTimerRef.current)
  }, [openingSoundActive, startupOpeningRunsInMain])

  useEffect(() => {
    if (!openingSoundActive) {
      openingSoundCleanupRef.current?.()
      openingSoundCleanupRef.current = undefined
      return
    }

    const cleanup = playOpeningSerenitySound(openingSoundVolume)
    openingSoundCleanupRef.current = cleanup
    return () => {
      cleanup()
      if (openingSoundCleanupRef.current === cleanup) openingSoundCleanupRef.current = undefined
    }
  }, [openingSoundActive, openingSoundVolume])

  useEffect(() => {
    return () => {
      openingSoundCleanupRef.current?.()
      openingSoundCleanupRef.current = undefined
    }
  }, [])

  useEffect(() => {
    if (detachedWindow) return undefined
    observedPersistedTokenRef.current = persistedStateChangeToken(useBrowserStore.getState())
    const unsubscribe = useBrowserStore.subscribe((state) => {
      if (!state.hydrated) return
      const token = persistedStateChangeToken(state)
      if (token === observedPersistedTokenRef.current) return
      observedPersistedTokenRef.current = token
      if (autosaveTimerRef.current !== undefined) return
      autosaveTimerRef.current = window.setTimeout(() => flushPendingSave('debounce'), 900)
    })

    const pagehide = (): void => flushPendingSave('pagehide')
    const visibilitychange = (): void => {
      if (document.visibilityState === 'hidden') flushPendingSave('visibilitychange')
    }
    const persistNavigation = (): void => {
      if (autosaveTimerRef.current !== undefined) return
      autosaveTimerRef.current = window.setTimeout(() => flushPendingSave('navigation'), 900)
    }

    window.addEventListener('pagehide', pagehide)
    window.addEventListener('vast:persist-navigation', persistNavigation)
    document.addEventListener('visibilitychange', visibilitychange)

    return () => {
      window.clearTimeout(autosaveTimerRef.current)
      flushPendingSave('effect-cleanup')
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('vast:persist-navigation', persistNavigation)
      document.removeEventListener('visibilitychange', visibilitychange)
      unsubscribe()
    }
  }, [detachedWindow, flushPendingSave])

  useEffect(() => {
    if (!detachedWindow) return undefined

    const pagehide = (): void => syncDetachedFinalTab('pagehide')
    const visibilitychange = (): void => {
      if (document.visibilityState === 'hidden') syncDetachedFinalTab('visibilitychange')
    }

    window.addEventListener('pagehide', pagehide)
    document.addEventListener('visibilitychange', visibilitychange)

    return () => {
      syncDetachedFinalTab('effect-cleanup')
      window.removeEventListener('pagehide', pagehide)
      document.removeEventListener('visibilitychange', visibilitychange)
    }
  }, [detachedWindow, syncDetachedFinalTab])

  useEffect(() => {
    const unsubscribeDownloads = window.vast.downloads.onChanged((item) => {
      useBrowserStore.getState().updateDownload(item)
      const previousState = downloadStateRef.current.get(item.id)
      downloadStateRef.current.set(item.id, item.state)

      if (!previousState) {
        if (item.state === 'completed') {
          pushToastRef.current({
            id: `download-complete-${item.id}`,
            tone: 'success',
            title: 'Download completed',
            message: item.filename,
            detail: item.savePath ? 'The file is ready in your Downloads panel.' : undefined,
            durationMs: 5_800
          })
        } else if (item.state === 'interrupted') {
          pushToastRef.current({
            id: `download-interrupted-${item.id}`,
            tone: 'error',
            title: 'Download interrupted',
            message: item.filename,
            detail: 'The transfer stopped before the file finished downloading.'
          })
        } else if (item.state === 'cancelled') {
          pushToastRef.current({
            id: `download-cancelled-${item.id}`,
            tone: 'warning',
            title: 'Download cancelled',
            message: item.filename,
            detail: 'The download was cancelled before it finished.'
          })
        }
        return
      }

      if (previousState === item.state) return
      if (item.state === 'completed') {
        pushToastRef.current({
          id: `download-complete-${item.id}`,
          tone: 'success',
          title: 'Download completed',
          message: item.filename,
          detail: item.savePath ? 'The file is ready in your Downloads panel.' : undefined,
          durationMs: 5_800
        })
      } else if (item.state === 'interrupted') {
        pushToastRef.current({
          id: `download-interrupted-${item.id}`,
          tone: 'error',
          title: 'Download interrupted',
          message: item.filename,
          detail: 'The transfer stopped before the file finished downloading.'
        })
      } else if (item.state === 'cancelled') {
        pushToastRef.current({
          id: `download-cancelled-${item.id}`,
          tone: 'warning',
          title: 'Download cancelled',
          message: item.filename,
          detail: 'The download was cancelled before it finished.'
        })
      }
    })

    const unsubscribeNotifications = window.vast.ui.onNotification((notification) => {
      pushToastRef.current(notification)
    })

    const unsubscribePrompts = window.vast.ui.onPrompt((prompt) => {
      startTransition(() => setUiPromptQueue((queue) => [...queue, prompt]))
    })

    const unsubscribeSitePermissions = window.vast.storage.onSitePermissionsChanged((sitePermissions) => {
      useBrowserStore.getState().updateSettings({ security: { sitePermissions } })
    })

    const unsubscribeExternalProtocols = window.vast.browser.onExternalProtocolRequest((request) => {
      const toastId = `external-app-${request.id}`
      const source = request.sourceOrigin
        ? (() => {
            try {
              return new URL(request.sourceOrigin).hostname
            } catch {
              return request.sourceOrigin
            }
          })()
        : 'This page'
      const resolve = (allow: boolean): void => {
        dismissToast(toastId)
        void window.vast.browser.resolveExternalProtocolRequest(request.id, allow).then((result) => {
          if (!result.ok) {
            pushToastRef.current({
              tone: 'error',
              title: allow ? 'Could not open app' : 'Request expired',
              message: result.error ?? 'The external app request is no longer available.'
            })
          }
        })
      }
      pushToastRef.current({
        id: toastId,
        tone: 'info',
        title: `Open ${request.scheme} app?`,
        message: `${source} wants to open an application on this device.`,
        detail: 'Vast will open it only after this one-time approval.',
        durationMs: 0,
        actions: [
          { label: 'Open app', action: () => resolve(true) },
          { label: 'Block', action: () => resolve(false) }
        ]
      })
    })

    const unsubscribeHtmlFullscreen = window.vast.browser.onHtmlFullscreenState((state) => {
      if (!state.active) {
        setHtmlFullscreenSession((current) => current?.webContentsId === state.webContentsId ? null : current)
        return
      }
      const apply = (): void => {
        const tabId = stageRef.current?.getTabIdForWebContents(state.webContentsId)
        if (tabId) setHtmlFullscreenSession({ tabId, webContentsId: state.webContentsId })
      }
      apply()
      window.setTimeout(apply, 0)
    })

    const unsubscribeUpdater = window.vast.updater.onEvent((payload) => {
      if (payload.event === 'ready') {
        pushToastRef.current({
          id: 'vast-update-ready',
          tone: 'success',
          title: `Vast v${payload.version ?? ''} ready to install`,
          message: 'Restart Vast to apply the update. Your data is preserved.',
          durationMs: 0,
          actions: [
            {
              label: 'Install now',
              action: () => {
                void window.vast.updater.install().then((result) => {
                  if (result.ok) return
                  pushToastRef.current({
                    id: 'vast-update-install-error',
                    tone: 'error',
                    title: 'Update could not start',
                    message: result.error ?? 'Vast could not safely checkpoint browser sessions before restarting.'
                  })
                })
              }
            }
          ]
        })
      } else if (payload.event === 'update-available') {
        pushToastRef.current({
          id: 'vast-update-available',
          tone: 'info',
          title: `Update available — v${payload.version ?? ''}`,
          message: 'Vast is downloading the new version in the background.',
          durationMs: 8_000
        })
      }
    })

    return () => {
      unsubscribeDownloads()
      unsubscribeNotifications()
      unsubscribePrompts()
      unsubscribeSitePermissions()
      unsubscribeExternalProtocols()
      unsubscribeHtmlFullscreen()
      unsubscribeUpdater()
    }
  }, [])

  useEffect(
    () =>
      window.vast.browser.onOpenTabRequest((request) => {
        handleBrowserTabOpenRequest(request, {
          getTabIdForWebContents: (webContentsId) => stageRef.current?.getTabIdForWebContents(webContentsId),
          getTabModel: () => useBrowserStore.getState(),
          isSafeUrl: isSafeLoadUrl,
          routeUrl: (url) => looksLikePdfUrl(url) ? createPdfViewerUrl(url) : url,
          titleForUrl: titleFromUrl
        })
      }),
    []
  )

  const runtime = useMemo<BrowserRuntime>(() => {
    const activeWebview = (): Electron.WebviewTag | undefined => stageRef.current?.getActiveWebview()

    const rememberTabSite = (
      tabId: ID,
      patch: Parameters<ReturnType<typeof useBrowserStore.getState>['upsertSiteMemory']>[1]
    ): void => {
      const state = useBrowserStore.getState()
      const tab = state.tabs.find((item) => item.id === tabId)
      const site = tab ? webOriginFor(tab.url) : undefined
      if (!site) return
      state.upsertSiteMemory(site.origin, { hostname: site.hostname, ...patch })
    }

    const activeHttpOrigin = (): string | undefined => {
      const active = getActiveTabSnapshot()
      return active ? webOriginFor(active.url)?.origin : undefined
    }

    const routePdfUrl = (url: string, options?: { returnTo?: string; reloadKey?: string }): string =>
      looksLikePdfUrl(url) ? createPdfViewerUrl(url, options) : url

    const effectiveActiveUrl = (tab: { url: string }): string => getEffectiveTabUrl(tab.url)

    const navigateTabTo = (tabId: ID, input: string): void => {
      const state = useBrowserStore.getState()
      const resolvedUrl = resolveAddressInput(input, state.settings.defaultSearchEngine)
      if (!isSafeLoadUrl(resolvedUrl)) return
      const currentTab = state.tabs.find((item) => item.id === tabId)
      const url = routePdfUrl(resolvedUrl, {
        returnTo: currentTab?.url && currentTab.url !== resolvedUrl ? currentTab.url : undefined
      })
      state.navigateTab(tabId, url)
      window.dispatchEvent(new Event('vast:persist-navigation'))
      if (url !== resolvedUrl) {
        state.updateTab(tabId, {
          canGoBack: Boolean(currentTab?.url && currentTab.url !== url),
          canGoForward: false
        })
      }
    }

    const openUrlInNewTab = (input: string, activate = true): void => {
      const state = useBrowserStore.getState()
      const workspace = selectActiveWorkspace(state)
      const resolvedUrl = resolveAddressInput(input, state.settings.defaultSearchEngine)
      if (!isSafeLoadUrl(resolvedUrl)) return
      const url = routePdfUrl(resolvedUrl)
      state.createTab({
        url,
        title: isInternalUrl(url) ? titleFromUrl(url) : resolvedUrl,
        workspaceId: workspace?.id,
        activate
      })
    }

    const setTabZoom = (tabId: ID, zoom: number): void => {
      useBrowserStore.getState().updateTab(tabId, { zoom })
      try {
        stageRef.current?.getWebview(tabId)?.setZoomFactor(zoom)
      } catch (error) {
        console.warn('[webview] Zoom will apply after dom-ready:', error)
      }
      rememberTabSite(tabId, { zoom })
    }

    const adjustZoom = (direction: 1 | -1, tabId?: ID): void => {
      const state = useBrowserStore.getState()
      const tab = tabId ? state.tabs.find((item) => item.id === tabId) : selectActiveTab(state)
      if (!tab) return
      if (isPdfViewerUrl(tab.url) && dispatchPdfCommand(direction === 1 ? 'zoom-in' : 'zoom-out', tab.id)) return
      const zoom = clamp(Number((tab.zoom + direction * 0.1).toFixed(2)), 0.3, 3)
      setTabZoom(tab.id, zoom)
    }

    const createNoteForActive = (quote?: string): void => {
      const state = useBrowserStore.getState()
      const active = selectActiveTab(state)
      const workspace = selectActiveWorkspace(state)
      const title = quote ? `Quote from ${active?.title ?? 'page'}` : active ? `Note for ${active.title}` : 'New note'
      const activeUrl = active ? effectiveActiveUrl(active) : undefined
      state.addNote({
        title,
        body: quote ? `> ${quote.replace(/\n/g, '\n> ')}\n\nSource: ${activeUrl ?? 'Vast'}` : '',
        url: activeUrl && !isInternalUrl(activeUrl) ? activeUrl : undefined,
        workspaceId: workspace?.id
      })
      state.setActiveSidePanel('notes')
    }

    const executeMacroAction = async (action: MacroAction): Promise<void> => {
      const state = useBrowserStore.getState()
      if (action.type === 'open-url-current' && action.url) {
        const active = selectActiveTab(state)
        if (active) navigateTabTo(active.id, action.url)
        else openUrlInNewTab(action.url)
      } else if (action.type === 'open-url-new-tab' && action.url) {
        openUrlInNewTab(action.url)
      } else if (action.type === 'open-multiple-urls') {
        for (const url of action.urls ?? []) openUrlInNewTab(url, false)
      } else if (action.type === 'open-internal-page' && action.internalUrl) {
        openUrlInNewTab(action.internalUrl)
      } else if (action.type === 'switch-workspace' && action.workspaceId) {
        state.setActiveWorkspace(action.workspaceId)
      } else if (action.type === 'create-workspace') {
        state.createWorkspace(action.workspaceName || 'Automation workspace', state.settings.accentColor, false)
      } else if (action.type === 'create-note') {
        state.addNote({
          title: action.noteTitle || 'Automation note',
          body: action.noteBody || '',
          workspaceId: selectActiveWorkspace(state)?.id
        })
      } else if (action.type === 'append-note') {
        const note = state.notes.find((item) => item.id === action.noteId)
        if (note) state.updateNote(note.id, { body: `${note.body}${note.body ? '\n\n' : ''}${action.noteBody ?? ''}` })
      } else if (action.type === 'open-side-panel' && action.sidePanelView) {
        state.setActiveSidePanel(action.sidePanelView)
      } else if (action.type === 'save-reading-list') {
        const active = selectActiveTab(state)
        const activeUrl = active ? effectiveActiveUrl(active) : undefined
        if (active && activeUrl && !isInternalUrl(activeUrl)) {
          state.addReadingListItem({ title: active.title, url: activeUrl, favicon: active.favicon, workspaceId: active.workspaceId })
        }
      } else if (action.type === 'save-session-snapshot') {
        state.addSessionSnapshot()
      } else if (action.type === 'close-duplicate-tabs') {
        const seen = new Set<string>()
        const duplicates = state.tabs.filter((tab) => {
          if (seen.has(tab.url)) return true
          seen.add(tab.url)
          return false
        })
        if (duplicates.length > 0) state.openPromptDialog({
          title: 'Close duplicate tabs?',
          description: `${duplicates.length} duplicate tab${duplicates.length === 1 ? '' : 's'} will be closed.`,
          label: '',
          hideInput: true,
          allowEmpty: true,
          confirmLabel: 'Close duplicates',
          onConfirm: () => duplicates.forEach((tab) => useBrowserStore.getState().closeTab(tab.id))
        })
      } else if (action.type === 'hibernate-inactive-tabs') {
        const active = selectActiveTab(state)
        state.tabs.forEach((tab) => {
          if (isInactiveTabUnloadCandidate(tab, {
            activeTabId: active?.id,
            splitTabIds: state.splitView.enabled
              ? [state.splitView.primaryTabId, state.splitView.secondaryTabId].filter((id): id is ID => Boolean(id))
              : [],
            keepAwakeTabIds: state.keepAwakeTabIds,
            keepPinnedTabsAwake: state.settings.advanced.keepPinnedTabsAwake,
            internal: isInternalUrl(tab.url)
          })) {
            state.updateTab(tab.id, { lifecycle: 'sleeping' })
          }
        })
      } else if (action.type === 'toggle-focus-mode') {
        state.setFocusMode(!state.focusMode)
      } else if (action.type === 'run-command' && action.commandId === 'commandPalette') {
        state.setCommandPaletteOpen(true)
      }
    }

    return {
      focusAddress: () => window.dispatchEvent(new Event('vast-focus-address')),
      getActiveWebContentsId: () => {
        try {
          return activeWebview()?.getWebContentsId()
        } catch {
          return undefined
        }
      },
      navigateActive: (input) => {
        const state = useBrowserStore.getState()
        const active = selectActiveTab(state)
        if (!active) {
          openUrlInNewTab(input)
          return
        }
        navigateTabTo(active.id, input)
      },
      openUrlInNewTab,
      openIncognitoWindow: () => {
        const state = useBrowserStore.getState()
        const existing = state.workspaces.find((workspace) => workspace.isPrivate && workspace.name === 'Incognito')
        if (existing) {
          state.setActiveWorkspace(existing.id)
          state.createTab({ workspaceId: existing.id, url: INTERNAL_NEW_TAB_URL, activate: true })
          return
        }
        state.createWorkspace('Incognito', state.settings.accentColor, true)
      },
      goBack: () => {
        const active = getActiveTabSnapshot()
        const returnTo = active && isPdfViewerUrl(active.url) ? getPdfViewerReturnTo(active.url) : undefined
        if (active && returnTo) {
          useBrowserStore.getState().navigateTab(active.id, returnTo)
          return
        }
        const webview = activeWebview()
        if (webview?.canGoBack()) webview.goBack()
      },
      goForward: () => {
        const webview = activeWebview()
        if (webview?.canGoForward()) webview.goForward()
      },
      reload: () => {
        const active = getActiveTabSnapshot()
        if (!active) return
        if (isPdfViewerUrl(active.url)) {
          const sourceUrl = getPdfViewerSource(active.url)
          if (!sourceUrl) return
          useBrowserStore.getState().navigateTab(
            active.id,
            createPdfViewerUrl(sourceUrl, {
              returnTo: getPdfViewerReturnTo(active.url),
              reloadKey: String(Date.now())
            })
          )
          return
        }
        if (isInternalUrl(active.url)) {
          useBrowserStore.getState().updateTab(active.id, { status: 'idle', progress: 0, error: undefined })
          return
        }
        activeWebview()?.reload()
      },
      stop: () => activeWebview()?.stop(),
      closeActiveTab: () => {
        const active = getActiveTabSnapshot()
        if (active) useBrowserStore.getState().closeTab(active.id)
      },
      duplicateActiveTab: () => {
        const active = getActiveTabSnapshot()
        if (active) useBrowserStore.getState().duplicateTab(active.id)
      },
      reopenClosedTab: () => useBrowserStore.getState().reopenClosedTab(),
      openFindUi: () => {
        const state = useBrowserStore.getState()
        if (dispatchPdfCommand('focus-search')) {
          state.setFindOpen(false)
          return
        }
        state.setFindOpen(true)
      },
      adjustZoom,
      zoomIn: () => adjustZoom(1),
      zoomOut: () => adjustZoom(-1),
      resetZoom: () => {
        const active = getActiveTabSnapshot()
        if (!active) return
        if (isPdfViewerUrl(active.url) && dispatchPdfCommand('reset-zoom', active.id)) return
        setTabZoom(active.id, 1)
      },
      toggleMuteActive: () => {
        const active = getActiveTabSnapshot()
        if (!active) return
        const nextMuted = !active.muted
        const webview = activeWebview() as (Electron.WebviewTag & { setAudioMuted?: (muted: boolean) => void }) | undefined
        try {
          webview?.setAudioMuted?.(nextMuted)
        } catch {
          // The stored muted state will be applied after dom-ready.
        }
        useBrowserStore.getState().updateTab(active.id, { muted: nextMuted })
        rememberTabSite(active.id, { muted: nextMuted })
      },
      printActive: async () => {
        const active = getActiveTabSnapshot()
        if (active && isPdfViewerUrl(active.url) && dispatchPdfCommand('print', active.id)) {
          return
        }
        const webview = activeWebview() as
          | (Electron.WebviewTag & {
              getWebContentsId?: () => number
              print?: (
                options?: { silent?: boolean; printBackground?: boolean },
                callback?: (success: boolean, failureReason?: string) => void
              ) => void
            })
          | undefined
        if (!active || isInternalUrl(active.url) || !webview) {
          window.print()
          return
        }
        const webContentsId = webview.getWebContentsId?.()
        if (Number.isInteger(webContentsId) && webContentsId > 0) {
          try {
            const result = await window.vast.browser.printWebContents(webContentsId)
            if (result.ok) return
            console.warn('[print] Main process print failed:', result.error)
          } catch (error) {
            console.warn('[print] Main process print IPC failed:', error)
          }
        }
        await new Promise<void>((resolve) => {
          try {
            if (!webview.print) {
              window.print()
              resolve()
              return
            }
            webview.print({ silent: false, printBackground: true }, (success, failureReason) => {
              if (!success && failureReason) console.warn('[print] Failed:', failureReason)
              resolve()
            })
          } catch (error) {
            console.warn('[print] Failed:', error)
            resolve()
          }
        })
      },
      toggleDevTools: () => {
        if (!useBrowserStore.getState().settings.advanced.developerMode) {
          pushToastRef.current({
            tone: 'warning',
            title: 'Developer Mode is off',
            message: 'Enable Developer Mode in Advanced settings before opening web content DevTools.'
          })
          return
        }
        const webview = activeWebview()
        if (!webview) return
        if (webview.isDevToolsOpened()) webview.closeDevTools()
        else webview.openDevTools()
      },
      findInPage: (query, options) => {
        const webview = activeWebview()
        if (!webview || !query.trim()) return
        webview.findInPage(query, options)
      },
      stopFindInPage: () => activeWebview()?.stopFindInPage('clearSelection'),
      copyCurrentUrl: async () => {
        const active = getActiveTabSnapshot()
        if (active) await navigator.clipboard.writeText(effectiveActiveUrl(active))
      },
      copyCurrentTitle: async () => {
        const active = getActiveTabSnapshot()
        if (active) await navigator.clipboard.writeText(active.title)
      },
      saveCurrentToReadingList: () => {
        const active = getActiveTabSnapshot()
        const activeUrl = active ? effectiveActiveUrl(active) : undefined
        if (!active || !activeUrl || isInternalUrl(activeUrl)) return
        useBrowserStore.getState().addReadingListItem({
          title: active.title,
          url: activeUrl,
          favicon: active.favicon,
          workspaceId: active.workspaceId
        })
      },
      addCurrentBookmark: () => {
        const state = useBrowserStore.getState()
        const active = selectActiveTab(state)
        if (!active) return
        const activeUrl = effectiveActiveUrl(active)
        if (isInternalUrl(activeUrl)) {
          state.toggleCurrentBookmark()
          window.dispatchEvent(new Event('vast:persist-navigation'))
          return
        }
        const existing = state.bookmarks.find((bookmark) => bookmark.url === activeUrl)
        if (existing) {
          state.removeBookmark(existing.id)
          window.dispatchEvent(new Event('vast:persist-navigation'))
          return
        }
        state.addBookmark({
          title: active.title,
          url: activeUrl,
          favicon: active.favicon,
          workspaceId: active.workspaceId
        })
        window.dispatchEvent(new Event('vast:persist-navigation'))
      },
      createNoteForActive,
      runMacro: async (macroId, options = {}) => {
        const state = useBrowserStore.getState()
        const macro = state.macros.find((item) => item.id === macroId)
        if (!macro || !macro.enabled) return { ok: false, message: 'Macro is missing or disabled.' }
        const automationState = getFeatureState(VastFeatures.Automation, { settings: state.settings })
        if (!automationState.available) {
          openUrlInNewTab(INTERNAL_AUTOMATION_URL)
          return { ok: false, message: 'Enable Automation in Vast Labs first.' }
        }
        if (automationRunRef.current) return { ok: false, message: 'Another macro is already running.' }
        if (macro.actions.length > 25) return { ok: false, message: 'Macro exceeds the 25-action safety limit.' }
        const active = selectActiveTab(state)
        const activeUrl = active ? effectiveActiveUrl(active) : ''
        const hasSensitiveContext = isSensitiveAutomationUrl(activeUrl) || macroContainsSensitiveTarget(macro.actions)
        if (hasSensitiveContext && !options.allowSensitive) {
          const message = 'Blocked on authentication, payment, or vault content. Run it manually and approve the sensitive context.'
          useBrowserStore.getState().recordMacroRun({ macroId: macro.id, macroName: macro.name, status: 'error', message })
          return { ok: false, message }
        }
        if (options.dryRun) {
          const targets = macro.actions.map(macroActionUrl).filter((value): value is string => Boolean(value)).length
          const message = `Dry run passed: ${macro.actions.length} action${macro.actions.length === 1 ? '' : 's'}, ${targets} page target${targets === 1 ? '' : 's'}. No changes were made.`
          useBrowserStore.getState().recordMacroRun({ macroId: macro.id, macroName: macro.name, status: 'success', message })
          return { ok: true, message }
        }
        const runState = { macroId: macro.id, cancelled: false, startedAt: Date.now() }
        automationRunRef.current = runState
        try {
          for (let index = 0; index < macro.actions.length; index += 1) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
            if (runState.cancelled) throw new Error(`Stopped before step ${index + 1}.`)
            if (Date.now() - runState.startedAt > 30_000) throw new Error(`Timed out before step ${index + 1} (30 second limit).`)
            const action = macro.actions[index]
            try {
              await executeMacroAction(action)
            } catch (error) {
              throw new Error(`Step ${index + 1} (${action.type}) failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const message = `Ran ${macro.actions.length} action${macro.actions.length === 1 ? '' : 's'}.`
          useBrowserStore.getState().recordMacroRun({
            macroId: macro.id,
            macroName: macro.name,
            status: 'success',
            message
          })
          return { ok: true, message }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          useBrowserStore.getState().recordMacroRun({
            macroId: macro.id,
            macroName: macro.name,
            status: 'error',
            message
          })
          return { ok: false, message }
        } finally {
          if (automationRunRef.current === runState) automationRunRef.current = null
        }
      },
      stopMacro: (macroId) => {
        const activeRun = automationRunRef.current
        if (activeRun && (!macroId || activeRun.macroId === macroId)) activeRun.cancelled = true
      },
      fillLoginForActive: async () => {
        const webview = activeWebview()
        const origin = activeHttpOrigin()
        if (!webview || !origin) return
        const result = await window.vast.passwords.fillAutofill(webview.getWebContentsId(), origin)
        if (!result.ok) {
          window.alert(result.error ?? 'Could not unlock the password vault.')
          return
        }
        if (!result.filled) {
          window.alert('No saved login matches this exact site origin.')
        }
      },
      saveLoginForActive: async () => {
        const active = getActiveTabSnapshot()
        const webview = activeWebview()
        const origin = activeHttpOrigin()
        if (!active || !webview || !origin) return
        const workspace = useBrowserStore.getState().workspaces.find((item) => item.id === active.workspaceId)
        if (workspace?.isPrivate) {
          window.alert('Private workspace logins are not saved to the password vault.')
          return
        }
        const captured = (await webview.executeJavaScript(
          `
          (() => {
            const passwordInput = document.querySelector('input[type="password"]:not([disabled]):not([readonly])');
            if (!passwordInput || !passwordInput.value) return null;
            const form = passwordInput.closest('form') || document;
            const inputs = Array.from(form.querySelectorAll('input:not([disabled]):not([readonly])'));
            const usernameInput =
              inputs.find((input) => ['email', 'text', 'tel'].includes((input.getAttribute('type') || 'text').toLowerCase()) && input !== passwordInput) ||
              inputs.find((input) => input !== passwordInput && !['hidden', 'submit', 'button', 'checkbox', 'radio'].includes((input.getAttribute('type') || 'text').toLowerCase()));
            return {
              username: usernameInput?.value || '',
              password: passwordInput.value
            };
          })()
          `,
          false
        )) as { username: string; password: string } | null
        if (!captured?.password) {
          window.alert('No filled password field was found on this page.')
          return
        }
        useBrowserStore.getState().openPromptDialog({
          title: 'Save password?',
          description: `Save the filled credential for ${origin} in the encrypted Vast vault?`,
          label: '',
          hideInput: true,
          allowEmpty: true,
          confirmLabel: 'Save password',
          onConfirm: () => {
            void window.vast.passwords.saveCapturedLogin({
              origin,
              username: captured.username,
              password: captured.password,
              title: active.title,
              favicon: active.favicon
            }).then((result) => window.alert(result.ok ? 'Password saved in the encrypted Vast vault.' : result.error ?? 'Could not save password.'))
          }
        })
      },
      toggleSplitView: () => {
        const state = useBrowserStore.getState()
        if (state.splitView.enabled) {
          state.setSplitView(false)
          return
        }
        const active = selectActiveTab(state)
        const workspace = selectActiveWorkspace(state)
        if (!active || !workspace) return
        let secondary = state.tabs
          .filter((tab) => tab.workspaceId === workspace.id && tab.id !== active.id)
          .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)[0]
        if (!secondary) secondary = state.createTab({ url: INTERNAL_NEW_TAB_URL, workspaceId: workspace.id, activate: false })
        state.setSplitView(true, secondary.id, active.id)
      },
      switchToTab: (tabId) => useBrowserStore.getState().activateTab(tabId),
      getActivePageText: async () => {
        if (useBrowserStore.getState().settings.privacy.disablePageTextCapture) return ''
        const webview = activeWebview()
        if (!webview) return ''
        return (await webview.executeJavaScript(
          'document.body ? document.body.innerText.slice(0, 20000) : ""',
          false
        )) as string
      }
    }
  }, [])

  useEffect(() => {
    let lastAppliedKey = ''
    let releaseTimer: number | undefined
    const applyActiveSiteMemory = (): void => {
      const state = useBrowserStore.getState()
      const active = selectActiveTab(state)
      const site = active ? webOriginFor(active.url) : undefined
      if (!active || !site) return
      const memory = state.siteMemory.find((entry) => entry.origin === site.origin)
      const key = `${active.id}|${site.origin}`
      if (!memory || key === lastAppliedKey) return
      lastAppliedKey = key

      applyingSiteMemoryRef.current = true
      window.clearTimeout(releaseTimer)
      const webview = stageRef.current?.getWebview(active.id) as
        | (Electron.WebviewTag & { setAudioMuted?: (muted: boolean) => void })
        | undefined

      if (typeof memory.zoom === 'number' && memory.zoom !== active.zoom) {
        state.updateTab(active.id, { zoom: memory.zoom })
        try {
          webview?.setZoomFactor(memory.zoom)
        } catch {
          // BrowserStage applies stored zoom once the webview is ready.
        }
      }
      if (typeof memory.muted === 'boolean' && memory.muted !== active.muted) {
        state.updateTab(active.id, { muted: memory.muted })
        try {
          webview?.setAudioMuted?.(memory.muted)
        } catch {
          // BrowserStage applies stored audio state once the webview is ready.
        }
      }
      if (memory.sidePanelOpen === true) {
        if (memory.sidePanelView) state.setActiveSidePanel(memory.sidePanelView)
        else state.setSidePanelOpen(true)
      } else if (memory.sidePanelOpen === false) {
        state.setSidePanelOpen(false)
      }

      releaseTimer = window.setTimeout(() => {
        applyingSiteMemoryRef.current = false
      }, 0)
    }

    applyActiveSiteMemory()
    const unsubscribe = useBrowserStore.subscribe(applyActiveSiteMemory)
    return () => {
      window.clearTimeout(releaseTimer)
      applyingSiteMemoryRef.current = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let lastSignature = ''
    const rememberSidePanelForSite = (): void => {
      if (applyingSiteMemoryRef.current) return
      const state = useBrowserStore.getState()
      const active = selectActiveTab(state)
      const site = active ? webOriginFor(active.url) : undefined
      if (!site) return
      const signature = `${site.origin}|${state.sidePanelOpen ? 1 : 0}|${state.activeSidePanel}`
      if (signature === lastSignature) return
      lastSignature = signature
      state.upsertSiteMemory(site.origin, {
        hostname: site.hostname,
        sidePanelOpen: state.sidePanelOpen,
        sidePanelView: state.activeSidePanel
      })
    }

    rememberSidePanelForSite()
    const unsubscribe = useBrowserStore.subscribe(rememberSidePanelForSite)
    return unsubscribe
  }, [])

  useEffect(() => {
    let lastHandledMouseNavigation = { action: '', at: 0 }
    const onMouseNavigation = (event: MouseEvent): void => {
      const action = mouseNavigationActionForButton(event.button)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      if (!shouldTriggerMouseNavigation(event.type)) return

      const now = performance.now()
      if (lastHandledMouseNavigation.action === action && now - lastHandledMouseNavigation.at < 180) return
      lastHandledMouseNavigation = { action, at: now }

      if (action === 'back') runtime.goBack()
      else runtime.goForward()
    }

    window.addEventListener('mousedown', onMouseNavigation, true)
    window.addEventListener('mouseup', onMouseNavigation, true)
    window.addEventListener('auxclick', onMouseNavigation, true)
    return () => {
      window.removeEventListener('mousedown', onMouseNavigation, true)
      window.removeEventListener('mouseup', onMouseNavigation, true)
      window.removeEventListener('auxclick', onMouseNavigation, true)
    }
  }, [runtime])

  useEffect(() => {
    const runShortcut = (shortcut: string): void => {
      const store = useBrowserStore.getState()
      if (shortcut === 'commandPalette') store.setCommandPaletteOpen(!store.commandPaletteOpen)
      else if (shortcut === 'focusAddress') runtime.focusAddress()
      else if (shortcut === 'findInPage') runtime.openFindUi()
      else if (shortcut === 'reopenClosedTab') runtime.reopenClosedTab()
      else if (shortcut === 'newTab') runtime.openUrlInNewTab(INTERNAL_NEW_TAB_URL)
      else if (shortcut === 'closeTab') runtime.closeActiveTab()
      else if (shortcut === 'reload') runtime.reload()
      else if (shortcut === 'toggleSidebar') store.setSidebarCollapsed(!store.sidebarCollapsed)
      else if (shortcut === 'back') runtime.goBack()
      else if (shortcut === 'forward') runtime.goForward()
      else if (shortcut === 'zoomIn') runtime.zoomIn()
      else if (shortcut === 'zoomOut') runtime.zoomOut()
      else if (shortcut === 'resetZoom') runtime.resetZoom()
      else if (shortcut === 'print') void runtime.printActive()
      else if (shortcut === 'toggleAdBlocker') {
        store.updateSettings({ privacy: { adBlockerEnabled: !store.settings.privacy.adBlockerEnabled } })
      }
      else if (shortcut.startsWith('tab:')) {
        const workspace = selectActiveWorkspace(store)
        const index = Number(shortcut.slice(4)) - 1
        const tab = store.tabs.filter((item) => item.workspaceId === workspace?.id)[index]
        if (tab) store.activateTab(tab.id)
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const meta = event.ctrlKey || event.metaKey

      const shortcuts = useBrowserStore.getState().settings.keyboardShortcuts
      for (const shortcutName of Object.keys(shortcuts)) {
        if (matchesShortcut(event, shortcuts[shortcutName])) {
          event.preventDefault()
          runShortcut(shortcutName)
          return
        }
      }

      if (meta && /^[1-9]$/.test(event.key)) {
        event.preventDefault()
        runShortcut(`tab:${event.key}`)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    const unsubscribeShortcut = window.vast.browser.onShortcut(runShortcut)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unsubscribeShortcut()
    }
  }, [runtime])

  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()

      const now = performance.now()
      wheelZoomAccumulatorRef.current += event.deltaY
      if (Math.abs(wheelZoomAccumulatorRef.current) < 35 && now - lastWheelZoomRef.current < 120) return

      runtime.adjustZoom(wheelZoomAccumulatorRef.current < 0 ? 1 : -1)
      wheelZoomAccumulatorRef.current = 0
      lastWheelZoomRef.current = now
    }

    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [runtime])

  useEffect(() => {
    let clearTimer: number | undefined
    let frame = 0
    const onScrollActivity = (): void => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const shell = shellRef.current
        if (!shell) return
        shell.classList.add('is-scrolling')
        window.clearTimeout(clearTimer)
        clearTimer = window.setTimeout(() => shell.classList.remove('is-scrolling'), 140)
      })
    }

    window.addEventListener('scroll', onScrollActivity, { capture: true, passive: true })
    window.addEventListener('wheel', onScrollActivity, { capture: true, passive: true })
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.clearTimeout(clearTimer)
      window.removeEventListener('scroll', onScrollActivity, { capture: true })
      window.removeEventListener('wheel', onScrollActivity, { capture: true })
    }
  }, [])

  if (loadError) {
    return (
      <div className="grid h-screen place-items-center bg-vast-black p-8 text-white">
        <div className="rounded-3xl border border-white/10 bg-white/[0.06] p-8 shadow-glass">
          <div className="text-xl font-semibold">Vast could not load storage.</div>
          <div className="mt-3 text-sm text-vast-soft">{loadError}</div>
        </div>
      </div>
    )
  }

  if (!hydrated) {
    return openingVisible ? <VastOpeningAnimation visible /> : <div className="h-screen bg-vast-black" />
  }

  return (
    <BrowserRuntimeContext.Provider value={runtime}>
      <div
        ref={shellRef}
        className={`app-shell layout-${layoutMode} platform-${window.vast.app.platform} flex h-screen overflow-hidden bg-vast-black font-sans text-vast-bright ${htmlFullscreenSession ? 'is-html-fullscreen' : ''} ${activeTabIsNewTab ? 'is-new-tab' : ''} ${animations && !systemPrefersReducedMotion ? '' : 'no-motion'} ${constrainedGraphics ? 'low-effects' : ''} ${
          resolvedTheme === 'light' ? 'light-theme' : resolvedTheme === 'dim' ? 'dim-theme' : 'dark-theme'
        }`}
        data-appearance-bg={appearance.backgroundStyle}
        style={visualStyle}
      >
        {showSidebar && <Sidebar forcedCollapsed={autoCollapseSidebar} />}
        <section className="app-main-surface relative flex min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_50%_-10%,rgba(116,231,255,0.11),transparent_28%),linear-gradient(180deg,#090a0e_0%,#050507_100%)]">
          {!htmlFullscreenSession && !showHorizontalChrome && !showPuristChrome && <WindowControls placement="overlay" />}
          {showHorizontalChrome && <HorizontalChrome />}
          {showPuristChrome && <Suspense fallback={null}><PuristChrome /></Suspense>}
          {!focusMode && !htmlFullscreenSession && layoutMode === 'vertical' && <AddressBar compact />}
          <div className={`browser-stage-shell relative flex min-h-0 flex-1 ${htmlFullscreenSession ? 'is-html-fullscreen' : ''}`}>
            {!htmlFullscreenSession && <FindBar />}
            <LocalErrorBoundary name="Browser content">
              <Suspense fallback={<div className="min-h-0 flex-1 bg-[#050507]" />}>
                <BrowserStage
                  ref={stageRef}
                  htmlFullscreenTabId={htmlFullscreenSession?.tabId}
                  puristChromeVisible={showPuristChrome}
                />
              </Suspense>
            </LocalErrorBoundary>
          </div>
        </section>
        {CatAddonController && window.vast.app.startup.catAddonAvailable && catAddonEnabled && (
          <Suspense fallback={null}>
            <CatAddonController htmlFullscreen={Boolean(htmlFullscreenSession) || focusMode} />
          </Suspense>
        )}
        <Suspense fallback={null}>
          {!focusMode && !htmlFullscreenSession && sidePanelOpen && (
            <LocalErrorBoundary name="Sidebar" overlay onDismiss={() => useBrowserStore.getState().setSidePanelOpen(false)}>
              <SidePanel pinned={sidebarPinned} />
            </LocalErrorBoundary>
          )}
          {!htmlFullscreenSession && commandPaletteOpen && (
            <LocalErrorBoundary name="Command palette" overlay onDismiss={() => useBrowserStore.getState().setCommandPaletteOpen(false)}>
              <CommandPalette />
            </LocalErrorBoundary>
          )}
          {!htmlFullscreenSession && smartUnloadOpen && (
            <LocalErrorBoundary name="Tab unload panel" overlay onDismiss={() => useBrowserStore.getState().setSmartUnloadOpen(false)}>
              <SmartUnloadPanel />
            </LocalErrorBoundary>
          )}
          {!htmlFullscreenSession && settingsOpen && (
            <LocalErrorBoundary name="Settings" overlay onDismiss={() => useBrowserStore.getState().setSettingsOpen(false)}>
              <SettingsModal />
            </LocalErrorBoundary>
          )}
        </Suspense>
        {!htmlFullscreenSession && <PromptDialog />}
        {!htmlFullscreenSession && <ContextMenu />}
        {!htmlFullscreenSession && <NotificationsOverlay toasts={toasts} downloads={downloads} onDismiss={dismissToast} />}
        {!htmlFullscreenSession && <ActionPromptModal prompt={activeUiPrompt} onResolve={(actionId) => activeUiPrompt && resolveUiPrompt(activeUiPrompt, actionId)} />}
        {!htmlFullscreenSession && <Suspense fallback={null}><RelayNoticeOverlay /></Suspense>}
      </div>
      <VastOpeningAnimation visible={openingVisible} />
    </BrowserRuntimeContext.Provider>
  )
}
