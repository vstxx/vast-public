import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildCosmeticAdBlockScript } from '../../../shared/adblock'
import { getFeatureState, VastFeatures } from '../../../shared/feature-gates'
import { mouseNavigationActionForButton, shouldTriggerMouseNavigation } from '../../../shared/mouse-navigation'
import type { ID, Tab, WorkspaceIdentitySettings } from '../../../shared/types'
import { buildSpoofingInjectionScript } from '../../../shared/spoofing'
import { GuestNavigationUrlQueue, shouldAcceptWebviewNavigationEvent, webviewNavigationUrl } from '../../../shared/webview-navigation'
import { shouldBypassVastInterference } from '../../../shared/auth-compatibility-policy'
import { automaticPasswordCaptureOrigin } from '../../../shared/password-capture-policy'
import { isLikelyCallUrl } from '../../../shared/call-protection'
import { cleanTrackingUrl, hostMatchesList, siteDomain } from '../../../shared/url-cleaning'
import { resolveWorkspaceIdentity } from '../../../shared/workspace-identity'
import { useBrowserStore, type ContextMenuItem } from '../../store/browser-store'
import { createPdfViewerUrl, displayUrl, isInternalUrl, isSafeLoadUrl, looksLikePdfUrl, webOriginFor } from '../../lib/url'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { getExtensionContributions } from '../../extensions/extension-runtime'

interface WebviewSurfaceProps {
  tab: Tab
  visible: boolean
  isPrivate: boolean
  identity: WorkspaceIdentitySettings
  partition: string
  identitySeed: string
  register: (tabId: ID, webview?: Electron.WebviewTag) => void
  setMediaActive: (tabId: ID, active: boolean) => void
  onFocused: (tabId: ID) => void
  puristSafeSpace: boolean
}

type MediaAwareWebviewTag = Electron.WebviewTag & {
  isCurrentlyAudible?: () => boolean
}


function contextSeparator(id: string): ContextMenuItem {
  return { id, label: '', separator: true }
}

interface BrowserStageProps {
  htmlFullscreenTabId?: ID
  puristChromeVisible?: boolean
}

function siteInterventionsAreDisabled(siteInterventionsDisabled: readonly string[], rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && siteInterventionsDisabled.includes(parsed.origin)
  } catch {
    return false
  }
}

function pushContextItem(items: ContextMenuItem[], item: ContextMenuItem | undefined): void {
  if (item) items.push(item)
}

function pushContextSeparator(items: ContextMenuItem[], id: string): void {
  if (items.length === 0 || items[items.length - 1]?.separator) return
  items.push(contextSeparator(id))
}

function fallbackDownloadName(sourceUrl: string, suggestedFilename?: string, mediaType?: string): string {
  if (suggestedFilename) return suggestedFilename
  if (!sourceUrl.startsWith('blob:') && !sourceUrl.startsWith('data:')) {
    try {
      const candidate = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop()
      if (candidate) return decodeURIComponent(candidate)
    } catch {
      // Fall through to generic naming.
    }
  }

  if (mediaType === 'image') return 'image.png'
  if (mediaType === 'video') return 'video.mp4'
  if (mediaType === 'audio') return 'audio.mp3'
  return 'download.bin'
}


function hasHttpOrigin(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}


function WebviewSurfaceComponent({ tab, visible, isPrivate, identity, partition, identitySeed, register, setMediaActive, onFocused, puristSafeSpace }: WebviewSurfaceProps): JSX.Element {
  const ref = useRef<Electron.WebviewTag | null>(null)
  const visibleRef = useRef(visible)
  const puristSafeSpaceRef = useRef(puristSafeSpace)
  const [puristSafeSpaceVisible, setPuristSafeSpaceVisible] = useState(false)
  const initialUrlRef = useRef(tab.url)
  const mountWebview = useCallback((webview: Electron.WebviewTag | null): void => {
    ref.current = webview
    if (!webview) return

    // React does not reliably serialize Electron's custom boolean
    // `allowpopups` attribute. Set it before src so the guest is attached with
    // native window-open support from its first navigation.
    webview.setAttribute('allowpopups', '')
    webview.setAttribute('src', initialUrlRef.current)
  }, [])
  const latestTabRef = useRef(tab)
  const identityRef = useRef(identity)
  const identitySeedRef = useRef(identitySeed)
  const domReadyRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)
  const lastKnownUrlRef = useRef(tab.url)
  const guestNavigationUrlsRef = useRef(new GuestNavigationUrlQueue())
  const webContentsIdRef = useRef<number | undefined>(undefined)
  const wheelZoomAccumulatorRef = useRef(0)
  const lastWheelZoomRef = useRef(0)
  const lastMouseNavigationRef = useRef({ action: '', at: 0 })
  const updateTab = useBrowserStore((state) => state.updateTab)
  const privacySettings = useBrowserStore((state) => state.settings.privacy)
  const spoofingSettings = useBrowserStore((state) => state.settings.spoofing)
  const spoofingAvailable = useBrowserStore((state) =>
    getFeatureState(VastFeatures.Spoofing, { settings: state.settings }).available
  )
  const effectiveSpoofingSettings = useMemo(
    () => spoofingAvailable ? spoofingSettings : { ...spoofingSettings, enabled: false },
    [spoofingAvailable, spoofingSettings]
  )
  const effectiveSpoofingSettingsRef = useRef(effectiveSpoofingSettings)
  const upsertSiteMemory = useBrowserStore((state) => state.upsertSiteMemory)
  const addNote = useBrowserStore((state) => state.addNote)
  const addHistoryEntry = useBrowserStore((state) => state.addHistoryEntry)
  const createTab = useBrowserStore((state) => state.createTab)
  const setFindResult = useBrowserStore((state) => state.setFindResult)
  const setFindOpen = useBrowserStore((state) => state.setFindOpen)
  const openContextMenu = useBrowserStore((state) => state.openContextMenu)
  const runtime = useBrowserRuntime()

  useEffect(() => {
    latestTabRef.current = tab
  }, [tab])

  useEffect(() => {
    visibleRef.current = visible
    if (!visible) setPuristSafeSpaceVisible(false)
  }, [visible])

  useEffect(() => {
    puristSafeSpaceRef.current = puristSafeSpace
    if (!puristSafeSpace) setPuristSafeSpaceVisible(false)
  }, [puristSafeSpace])

  useEffect(() => {
    identityRef.current = identity
    identitySeedRef.current = identitySeed
  }, [identity, identitySeed])

  useEffect(() => {
    effectiveSpoofingSettingsRef.current = effectiveSpoofingSettings
  }, [effectiveSpoofingSettings])

  useEffect(() => {
    const webview = ref.current
    if (!webview) return
    register(tab.id, webview)

    const updateNavigationFlags = (): void => {
      updateTab(tab.id, {
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward()
      })
    }

    const loadRequestedUrl = (url: string): void => {
      try {
        if (webview.getURL() !== url) {
          void webview.loadURL(url).catch((error) => {
            console.warn('[webview] Failed to navigate:', error)
          })
        }
      } catch {
        pendingUrlRef.current = url
      }
    }

    const rememberCurrentSite = (visited = false): void => {
      if (isPrivate) return
      const latestTab = latestTabRef.current
      const currentUrl = webview.getURL() || latestTab.url
      const site = webOriginFor(currentUrl)
      if (!site) return
      upsertSiteMemory(site.origin, {
        hostname: site.hostname,
        title: webview.getTitle() || latestTab.title,
        favicon: latestTab.favicon,
        lastUrl: currentUrl,
        zoom: latestTab.zoom,
        muted: latestTab.muted,
        visited
      })
    }

    const sendToGuest = (channel: string, payload: unknown): boolean => {
      if (!domReadyRef.current || !(webview as HTMLElement).isConnected) return false
      try {
        webview.send(channel, payload)
        return true
      } catch {
        // Electron can detach a webview between the connection check and send().
        return false
      }
    }

    const configurePasswordCapture = (): void => {
      const currentUrl = webview.getURL() || latestTabRef.current.url
      const origin = automaticPasswordCaptureOrigin(currentUrl)
      if (isPrivate || !origin) {
        sendToGuest('vast:password-capture-config', { enabled: false })
        return
      }
      const webContentsId = webview.getWebContentsId()
      void window.vast.passwords.captureStatus(webContentsId, origin).then((result) => {
        if (!(webview as HTMLElement).isConnected) return
        const latestOrigin = automaticPasswordCaptureOrigin(webview.getURL() || latestTabRef.current.url)
        sendToGuest('vast:password-capture-config', { enabled: result.ok && result.enabled === true && latestOrigin === origin })
      }).catch(() => sendToGuest('vast:password-capture-config', { enabled: false }))
    }

    const onDomReady = (): void => {
      domReadyRef.current = true
      register(tab.id, webview)
      updateNavigationFlags()
      const currentUrl = webview.getURL() || latestTabRef.current.url
      lastKnownUrlRef.current = currentUrl
      webContentsIdRef.current = webview.getWebContentsId()
      const latestSettings = useBrowserStore.getState().settings
      void window.vast.privacy.configureIdentity(webContentsIdRef.current, identityRef.current, currentUrl, identitySeedRef.current).catch(() => undefined)
      const bypassInterventions = shouldBypassVastInterference({ url: currentUrl }) || siteInterventionsAreDisabled(latestSettings.privacy.siteInterventionsDisabled, currentUrl)
      if (!bypassInterventions) {
        const spoofingScript = buildSpoofingInjectionScript(effectiveSpoofingSettingsRef.current, window.vast.app.versions.chrome)
        if (spoofingScript) {
          void webview.executeJavaScript(spoofingScript, false).catch(() => undefined)
        }
        void webview
          .executeJavaScript(
            buildCosmeticAdBlockScript(
              latestSettings.privacy.adBlockerEnabled,
              latestSettings.privacy.adBlockerMode ?? 'standard'
            ),
            false
          )
          .catch(() => undefined)
      }
      const latestTab = latestTabRef.current
      const audioWebview = webview as Electron.WebviewTag & { setAudioMuted?: (muted: boolean) => void }
      audioWebview.setAudioMuted?.(Boolean(latestTab.muted))
      const pendingUrl = pendingUrlRef.current
      if (pendingUrl) {
        pendingUrlRef.current = null
        loadRequestedUrl(pendingUrl)
      }
      sendToGuest('vast:password-autofill-config', { enabled: false })
      configurePasswordCapture()
    }

    const onStart = (): void => {
      setPuristSafeSpaceVisible(false)
      sendToGuest('vast:password-autofill-config', { enabled: false })
      updateTab(tab.id, {
        status: 'loading',
        progress: 0.18,
        error: undefined,
        loginFormDetected: false
      })
    }

    const configureAutofill = (): void => {
      const currentUrl = webview.getURL() || latestTabRef.current.url
      const origin = automaticPasswordCaptureOrigin(currentUrl)
      if (!origin || isPrivate) {
        updateTab(tab.id, { loginFormDetected: false })
        sendToGuest('vast:password-autofill-config', { enabled: false })
        return
      }
      updateTab(tab.id, { loginFormDetected: true })
      const webContentsId = webview.getWebContentsId()
      void window.vast.passwords.getAutofillSuggestions(webContentsId, origin).then((result) => {
        if (!(webview as HTMLElement).isConnected) return
        const latestOrigin = automaticPasswordCaptureOrigin(webview.getURL() || latestTabRef.current.url)
        if (latestOrigin !== origin || !result.ok || !result.suggestions?.length) {
          sendToGuest('vast:password-autofill-config', { enabled: false })
          return
        }
        sendToGuest('vast:password-autofill-config', { enabled: true, suggestions: result.suggestions })
      }).catch(() => sendToGuest('vast:password-autofill-config', { enabled: false }))
    }
    const onStop = (): void => {
      updateTab(tab.id, {
        status: 'idle',
        progress: 1,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward()
      })
      rememberCurrentSite(true)
      window.setTimeout(() => updateTab(tab.id, { progress: 0 }), 300)
    }

    const onNavigate = (event: Event): void => {
      const latestTab = latestTabRef.current
      const currentWebviewUrl = webview.getURL()
      if (!shouldAcceptWebviewNavigationEvent(event as unknown as Parameters<typeof shouldAcceptWebviewNavigationEvent>[0], currentWebviewUrl)) {
        return
      }
      const url = webviewNavigationUrl(event as unknown as Parameters<typeof webviewNavigationUrl>[0], currentWebviewUrl)
      lastKnownUrlRef.current = url
      guestNavigationUrlsRef.current.remember(url)
      if (looksLikePdfUrl(url)) {
        const returnTo = latestTab.url && latestTab.url !== url ? latestTab.url : undefined
        updateTab(tab.id, {
          url: createPdfViewerUrl(url, { returnTo }),
          displayUrl: url,
          canGoBack: Boolean(returnTo),
          canGoForward: false,
          error: undefined
        })
        addHistoryEntry({
          title: webview.getTitle() || latestTab.title,
          url,
          favicon: latestTab.favicon,
          workspaceId: latestTab.workspaceId
        })
        rememberCurrentSite()
        return
      }
      updateTab(tab.id, {
        url,
        displayUrl: url,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        error: undefined
      })
      window.dispatchEvent(new Event('vast:persist-navigation'))
      addHistoryEntry({
        title: webview.getTitle() || latestTab.title,
        url,
        favicon: latestTab.favicon,
        workspaceId: latestTab.workspaceId
      })
      rememberCurrentSite()
    }

    const onTitle = (event: Event): void => {
      const title = (event as unknown as { title?: string }).title
      if (title) {
        updateTab(tab.id, { title })
        rememberCurrentSite()
      }
    }

    const onFavicon = (event: Event): void => {
      const favicons = (event as unknown as { favicons?: string[] }).favicons
      if (favicons?.[0]) {
        updateTab(tab.id, { favicon: favicons[0] })
        rememberCurrentSite()
      }
    }

    const onFail = (event: Event): void => {
      const detail = event as unknown as {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
        isMainFrame?: boolean
      }
      if (detail.errorCode === -3 || detail.isMainFrame === false) return
      updateTab(tab.id, {
        status: 'error',
        progress: 0,
        error: {
          code: detail.errorCode ?? 0,
          description: detail.errorDescription ?? 'Load failed',
          validatedUrl: detail.validatedURL ?? tab.url
        }
      })
    }

    let mediaPauseTimer: number | undefined
    const syncMediaActivity = (): void => {
      const audible = Boolean((webview as MediaAwareWebviewTag).isCurrentlyAudible?.())
      setMediaActive(tab.id, audible)
    }
    const onMediaStarted = (): void => {
      window.clearTimeout(mediaPauseTimer)
      mediaPauseTimer = undefined
      setMediaActive(tab.id, true)
    }
    const onMediaPaused = (): void => {
      window.clearTimeout(mediaPauseTimer)
      mediaPauseTimer = window.setTimeout(() => {
        mediaPauseTimer = undefined
        syncMediaActivity()
      }, 1200)
    }

    const onFoundInPage = (event: Event): void => {
      const result = event as unknown as { result?: { activeMatchOrdinal?: number; matches?: number } }
      setFindResult({
        activeMatchOrdinal: result.result?.activeMatchOrdinal ?? 0,
        matches: result.result?.matches ?? 0
      })
    }

    const onGuestCrash = (event: Event): void => {
      const detail = event as unknown as { reason?: string; exitCode?: number }
      updateTab(tab.id, {
        status: 'error',
        lifecycle: 'crashed',
        progress: 0,
        error: {
          code: detail.exitCode ?? -1,
          description: `Web page process stopped${detail.reason ? ` (${detail.reason})` : ''}.`,
          validatedUrl: latestTabRef.current.url
        }
      })
      setMediaActive(tab.id, false)
    }

    const onGuestDestroyed = (event: Event): void => {
      if ((webview as HTMLElement).isConnected && useBrowserStore.getState().tabs.some((item) => item.id === tab.id)) {
        onGuestCrash(event)
      }
    }

    const onGuestIpcMessage = (event: Event): void => {
      const message = event as unknown as { channel?: string; args?: unknown[] }
      if (message.channel === 'vast:scroll-boundary') {
        const atTop = message.args?.[0]
        if (typeof atTop !== 'boolean') return
        if (!atTop) {
          setPuristSafeSpaceVisible(false)
          if (visibleRef.current) window.dispatchEvent(new Event('vast-purist-page-scroll'))
        }
        return
      }
      if (message.channel === 'vast:purist-top-overscroll') {
        const action = message.args?.[0]
        if (action !== 'show' && action !== 'hide') return
        setPuristSafeSpaceVisible(action === 'show' && puristSafeSpaceRef.current && visibleRef.current)
        return
      }
      if (message.channel === 'vast:login-form-available') {
        configureAutofill()
        return
      }
      if (message.channel === 'vast:autofill-select') {
        const credentialId = message.args?.[0]
        if (typeof credentialId !== 'string' || !credentialId || isPrivate) return
        const currentUrl = webview.getURL() || latestTabRef.current.url
        if (!hasHttpOrigin(currentUrl)) return
        const origin = new URL(currentUrl).origin
        void window.vast.passwords.fillById(credentialId, webview.getWebContentsId(), origin).catch(() => undefined)
        return
      }
      if (message.channel !== 'vast:password-login-candidate' || isPrivate) return
      const input = message.args?.[0]
      if (!input || typeof input !== 'object') return
      const candidate = input as { origin?: unknown; username?: unknown; password?: unknown }
      const currentOrigin = automaticPasswordCaptureOrigin(webview.getURL() || latestTabRef.current.url)
      if (!currentOrigin || candidate.origin !== currentOrigin || typeof candidate.username !== 'string' || typeof candidate.password !== 'string') return
      if (candidate.username.length > 512 || candidate.password.length < 1 || candidate.password.length > 4096) return
      const latestTab = latestTabRef.current
      void window.vast.passwords.captureLogin(webview.getWebContentsId(), {
        origin: currentOrigin,
        username: candidate.username,
        password: candidate.password,
        title: latestTab.title,
        favicon: latestTab.favicon
      }).then((result) => {
        if (result.ok && result.outcome === 'suppressed') configurePasswordCapture()
      }).catch(() => undefined)
    }

    const onWheelZoom = (event: Event): void => {
      const wheelEvent = event as WheelEvent
      if (!wheelEvent.ctrlKey && !wheelEvent.metaKey) return
      wheelEvent.preventDefault()
      wheelEvent.stopPropagation()

      const now = performance.now()
      wheelZoomAccumulatorRef.current += wheelEvent.deltaY
      if (Math.abs(wheelZoomAccumulatorRef.current) < 35 && now - lastWheelZoomRef.current < 120) return

      runtime.adjustZoom(wheelZoomAccumulatorRef.current < 0 ? 1 : -1, tab.id)
      wheelZoomAccumulatorRef.current = 0
      lastWheelZoomRef.current = now
    }

    const onMouseNavigation = (event: MouseEvent): void => {
      if (!visibleRef.current) return
      if (event.type === 'mousedown' && event.button === 0) onFocused(tab.id)
      const action = mouseNavigationActionForButton(event.button)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      if (!shouldTriggerMouseNavigation(event.type)) return

      // Side-button navigation must target the pane where the gesture happened,
      // not whichever pane happened to be active before the event.
      onFocused(tab.id)

      const now = performance.now()
      if (lastMouseNavigationRef.current.action === action && now - lastMouseNavigationRef.current.at < 180) return
      lastMouseNavigationRef.current = { action, at: now }

      if (action === 'back') runtime.goBack()
      else runtime.goForward()
    }

    const onFocusedSurface = (): void => {
      if (visibleRef.current) onFocused(tab.id)
    }

    const onContextMenu = (event: Event): void => {
      if (!visibleRef.current) return
      onFocused(tab.id)
      const params = (event as unknown as {
        params?: {
          x?: number
          y?: number
          linkURL?: string
          srcURL?: string
          mediaType?: string
          hasImageContents?: boolean
          suggestedFilename?: string
          pageURL?: string
          selectionText?: string
          isEditable?: boolean
        }
      }).params
      const rect = webview.getBoundingClientRect()
      const x = rect.left + (params?.x ?? 12)
      const y = rect.top + (params?.y ?? 12)
      const linkUrl = params?.linkURL?.trim()
      const sourceUrl = params?.srcURL?.trim()
      const mediaType = params?.mediaType ?? 'none'
      const hasImageContents = Boolean(params?.hasImageContents)
      const suggestedFilename = params?.suggestedFilename?.trim()
      const selectionText = params?.selectionText?.trim()
      const latestTab = latestTabRef.current
      const linkPreviewSite = linkUrl && isSafeLoadUrl(linkUrl) ? webOriginFor(linkUrl) : undefined
      const stripAffiliateParameters = useBrowserStore.getState().settings.privacy.stripAffiliateParameters
      const cleanLink = linkUrl ? cleanTrackingUrl(linkUrl, stripAffiliateParameters) : undefined
      const cleanPage = cleanTrackingUrl(latestTab.url, stripAffiliateParameters)

      const isImage = mediaType === 'image' && Boolean(sourceUrl)
      const canOpenLink = Boolean(linkUrl && isSafeLoadUrl(linkUrl))
      const canOpenSource = Boolean(sourceUrl && isSafeLoadUrl(sourceUrl))
      const canSaveSource = Boolean(sourceUrl)
      const canCopyImage = isImage && hasImageContents
      const canGoBack = webview.canGoBack()
      const canGoForward = webview.canGoForward()
      const sourceKindLabel = isImage ? 'image' : mediaType === 'video' ? 'video' : mediaType === 'audio' ? 'audio' : 'media'
      const sourceDetail = sourceUrl
        ? suggestedFilename ??
          (sourceUrl.startsWith('data:')
            ? 'Embedded image'
            : sourceUrl.startsWith('blob:')
              ? 'Page-generated resource'
              : displayUrl(sourceUrl))
        : undefined

      const saveSourceToFiles = async (): Promise<void> => {
        if (!sourceUrl) return
        if (sourceUrl.startsWith('blob:') || sourceUrl.startsWith('data:')) {
          await webview.executeJavaScript(
            `(() => {
              const anchor = document.createElement('a')
              anchor.href = ${JSON.stringify(sourceUrl)}
              anchor.download = ${JSON.stringify(fallbackDownloadName(sourceUrl, suggestedFilename, mediaType))}
              anchor.style.display = 'none'
              ;(document.body ?? document.documentElement).appendChild(anchor)
              anchor.click()
              anchor.remove()
              return true
            })()`,
            true
          )
          return
        }

        const result = await window.vast.browser.downloadUrl(webview.getWebContentsId(), sourceUrl)
        if (!result.ok) {
          console.warn('[context-menu] Failed to save resource:', result.error)
        }
      }

      const items: ContextMenuItem[] = []

      if (linkUrl) {
        pushContextItem(
          items,
          canOpenLink
            ? {
                id: 'open-link',
                label: 'Open link in new tab',
                detail: displayUrl(linkUrl),
                action: () => {
                  void createTab({ url: linkUrl, title: linkUrl, workspaceId: latestTab.workspaceId, groupId: latestTab.groupId, activate: true })
                }
              }
            : undefined
        )
        pushContextItem(items, {
          id: 'copy-link',
          label: 'Copy link address',
          detail: canOpenLink ? undefined : displayUrl(linkUrl),
          action: () => navigator.clipboard.writeText(linkUrl)
        })
        if (cleanLink?.changed) {
          pushContextItem(items, {
            id: 'copy-clean-link',
            label: 'Copy clean link',
            detail: `Removed: ${cleanLink.removedParameters.join(', ')}`,
            action: () => navigator.clipboard.writeText(cleanLink.url)
          })
        }
        if (canOpenLink) {
          pushContextSeparator(items, 'identity-link-separator')
          for (const workspace of useBrowserStore.getState().workspaces) {
            pushContextItem(items, {
              id: `open-link-identity-${workspace.id}`,
              label: `Open in ${workspace.name} identity`,
              detail: resolveWorkspaceIdentity(workspace).sessionMode,
              action: () => {
                void createTab({
                  url: linkUrl,
                  title: linkUrl,
                  workspaceId: latestTab.workspaceId,
                  identityWorkspaceId: workspace.id,
                  groupId: latestTab.groupId,
                  activate: true
                })
              }
            })
          }
        }
      }

      if (sourceUrl) {
        pushContextSeparator(items, 'media-separator')
        if (canCopyImage) {
          pushContextItem(items, {
            id: 'copy-image',
            label: 'Copy image',
            action: async () => {
              const result = await window.vast.browser.copyImageAt(webview.getWebContentsId(), params?.x ?? 0, params?.y ?? 0)
              if (!result.ok) {
                console.warn('[context-menu] Failed to copy image:', result.error)
              }
            }
          })
        }
        if (isImage && canSaveSource) {
          pushContextItem(items, {
            id: 'save-image',
            label: 'Save image to files',
            detail: sourceDetail,
            action: saveSourceToFiles
          })
        }
        if (canOpenSource) {
          pushContextItem(items, {
            id: 'open-source',
            label: `Open ${sourceKindLabel} in new tab`,
            detail: isImage ? undefined : sourceDetail,
            action: () => {
              void createTab({ url: sourceUrl, title: sourceUrl, workspaceId: latestTab.workspaceId, groupId: latestTab.groupId, activate: true })
            }
          })
        }
      }

      if (selectionText) {
        pushContextSeparator(items, 'selection-separator')
        pushContextItem(items, {
          id: 'copy-selection',
          label: 'Copy selection',
          action: () => navigator.clipboard.writeText(selectionText)
        })
      }

      pushContextSeparator(items, 'navigation-separator')
      pushContextItem(
        items,
        canGoBack
          ? {
              id: 'back',
              label: 'Back',
              action: () => webview.goBack()
            }
          : undefined
      )
      pushContextItem(
        items,
        canGoForward
          ? {
              id: 'forward',
              label: 'Forward',
              action: () => webview.goForward()
            }
          : undefined
      )
      pushContextItem(items, {
        id: 'reload',
        label: 'Reload',
        shortcut: 'Ctrl/Cmd+R',
        action: () => webview.reload()
      })
      pushContextItem(items, {
        id: 'find',
        label: 'Find in page',
        shortcut: 'Ctrl/Cmd+F',
        action: runtime.openFindUi
      })

      pushContextSeparator(items, 'page-actions-separator')
      pushContextItem(items, {
        id: 'copy-page-url',
        label: 'Copy page URL',
        action: () => navigator.clipboard.writeText(latestTab.url)
      })
      if (cleanPage.changed) {
        pushContextItem(items, {
          id: 'copy-clean-page-url',
          label: 'Copy clean page URL',
          detail: `Removed: ${cleanPage.removedParameters.join(', ')}`,
          action: () => navigator.clipboard.writeText(cleanPage.url)
        })
      }
      pushContextItem(items, {
        id: 'bookmark',
        label: 'Toggle bookmark',
        action: runtime.addCurrentBookmark
      })
      pushContextItem(items, {
        id: 'reading-list',
        label: 'Reading list',
        action: runtime.saveCurrentToReadingList
      })
      pushContextItem(items, {
        id: 'note-page',
        label: 'Create note',
        action: () => runtime.createNoteForActive()
      })
      if (selectionText) {
        pushContextItem(items, {
          id: 'quote-note',
          label: 'Save quote',
          action: () => {
            addNote({
              title: `Quote from ${latestTab.title}`,
              body: `> ${selectionText.replace(/\n/g, '\n> ')}\n\nSource: ${latestTab.url}`,
              url: latestTab.url,
              workspaceId: latestTab.workspaceId
            })
          }
        })
      }

      pushContextSeparator(items, 'secondary-actions-separator')
      pushContextItem(items, {
        id: 'print',
        label: 'Print page',
        shortcut: 'Ctrl/Cmd+P',
        action: runtime.printActive
      })
      if (latestTab.loginFormDetected) {
        pushContextItem(items, {
          id: 'fill-login',
          label: 'Fill login',
          action: runtime.fillLoginForActive
        })
        pushContextItem(items, {
          id: 'save-password',
          label: 'Save password',
          action: runtime.saveLoginForActive
        })
      }

      pushContextSeparator(items, 'advanced-separator')
      pushContextItem(items, {
        id: 'mute-site',
        label: latestTab.muted ? 'Unmute this site' : 'Mute this site',
        action: runtime.toggleMuteActive
      })
      pushContextItem(items, {
        id: 'inspect',
        label: 'Inspect element',
        action: () => {
          if (typeof webview.inspectElement === 'function') {
            webview.inspectElement(params?.x ?? 0, params?.y ?? 0)
          } else {
            runtime.toggleDevTools()
          }
        }
      })

      if (!isPrivate) {
        const extensionItems = getExtensionContributions().contextMenus
        if (extensionItems.length > 0) pushContextSeparator(items, 'extension-actions-separator')
        for (const item of extensionItems) pushContextItem(items, {
          id: `extension-${item.key}`,
          label: item.title,
          detail: item.extensionName,
          action: async () => { await window.vast.extensions.dispatchContribution(item.key, {
            tabId: latestTab.id,
            pageUrl: /^https?:\/\//i.test(latestTab.url) ? latestTab.url : undefined,
            linkUrl: linkUrl && /^https?:\/\//i.test(linkUrl) ? linkUrl.slice(0, 4_096) : undefined,
            selectionText: selectionText?.slice(0, 2_048)
          }) }
        })
      }

      while (items[items.length - 1]?.separator) items.pop()

      openContextMenu({
        x,
        y,
        title: latestTab.title,
        preview:
          linkUrl && isSafeLoadUrl(linkUrl)
            ? {
                url: displayUrl(linkUrl),
                host: linkPreviewSite?.hostname ?? displayUrl(linkUrl),
                duplicateCount: useBrowserStore.getState().tabs.filter((item) => item.url === linkUrl).length
              }
            : undefined,
        items
      })
    }

    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', onStop)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('page-title-updated', onTitle)
    webview.addEventListener('page-favicon-updated', onFavicon)
    webview.addEventListener('did-fail-load', onFail)
    webview.addEventListener('render-process-gone', onGuestCrash)
    webview.addEventListener('destroyed', onGuestDestroyed)
    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('found-in-page', onFoundInPage)
    webview.addEventListener('ipc-message', onGuestIpcMessage)
    webview.addEventListener('media-started-playing', onMediaStarted)
    webview.addEventListener('media-paused', onMediaPaused)
    ;(webview as HTMLElement).addEventListener('wheel', onWheelZoom, { passive: false })
    ;(webview as HTMLElement).addEventListener('mousedown', onMouseNavigation, true)
    ;(webview as HTMLElement).addEventListener('mouseup', onMouseNavigation, true)
    ;(webview as HTMLElement).addEventListener('auxclick', onMouseNavigation, true)
    ;(webview as HTMLElement).addEventListener('focus', onFocusedSurface)
    webview.addEventListener('context-menu', onContextMenu)

    return () => {
      // React may run passive cleanup after Electron has already detached the
      // custom element. Calling getURL/getWebContentsId at that point throws,
      // so cleanup only consumes values captured while the guest was alive.
      const currentUrl = lastKnownUrlRef.current || latestTabRef.current.url
      const currentState = useBrowserStore.getState()
      const tabWasClosed = !currentState.tabs.some((item) => item.id === tab.id)
      const clearSelected = hostMatchesList(currentUrl, currentState.settings.privacy.clearSiteDataOnClose)
      const currentSite = siteDomain(currentUrl)
      const anotherSiteTabIsOpen = currentState.tabs.some((item) => item.id !== tab.id && siteDomain(item.url) === currentSite)
      if (tabWasClosed && clearSelected && !anotherSiteTabIsOpen) {
        const origin = webOriginFor(currentUrl)?.origin
        if (origin) void window.vast.privacy.clearSiteData(origin, webContentsIdRef.current).catch(() => undefined)
      }
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', onStop)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('page-title-updated', onTitle)
      webview.removeEventListener('page-favicon-updated', onFavicon)
      webview.removeEventListener('did-fail-load', onFail)
      webview.removeEventListener('render-process-gone', onGuestCrash)
      webview.removeEventListener('destroyed', onGuestDestroyed)
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('found-in-page', onFoundInPage)
      webview.removeEventListener('ipc-message', onGuestIpcMessage)
      webview.removeEventListener('media-started-playing', onMediaStarted)
      webview.removeEventListener('media-paused', onMediaPaused)
      ;(webview as HTMLElement).removeEventListener('wheel', onWheelZoom)
      ;(webview as HTMLElement).removeEventListener('mousedown', onMouseNavigation, true)
      ;(webview as HTMLElement).removeEventListener('mouseup', onMouseNavigation, true)
      ;(webview as HTMLElement).removeEventListener('auxclick', onMouseNavigation, true)
      ;(webview as HTMLElement).removeEventListener('focus', onFocusedSurface)
      webview.removeEventListener('context-menu', onContextMenu)
      window.clearTimeout(mediaPauseTimer)
      domReadyRef.current = false
      register(tab.id, undefined)
      setMediaActive(tab.id, false)
    }
  }, [addHistoryEntry, addNote, createTab, isPrivate, onFocused, openContextMenu, register, runtime, setFindOpen, setFindResult, setMediaActive, tab.groupId, tab.id, tab.workspaceId, updateTab, upsertSiteMemory])

  useEffect(() => {
    const webview = ref.current
    if (!webview || !domReadyRef.current) return
    const currentUrl = webview.getURL() || tab.url
    if (shouldBypassVastInterference({ url: currentUrl }) || siteInterventionsAreDisabled(privacySettings.siteInterventionsDisabled, currentUrl)) return
    const spoofingScript = buildSpoofingInjectionScript(effectiveSpoofingSettings, window.vast.app.versions.chrome)
    if (!spoofingScript) return
    void webview.executeJavaScript(spoofingScript, false).catch(() => undefined)
  }, [effectiveSpoofingSettings, privacySettings.siteInterventionsDisabled, tab.url])

  useEffect(() => {
    const webview = ref.current
    if (!webview || !domReadyRef.current) return
    const currentUrl = webview.getURL() || tab.url
    if (shouldBypassVastInterference({ url: currentUrl }) || siteInterventionsAreDisabled(privacySettings.siteInterventionsDisabled, currentUrl)) return
    void webview
      .executeJavaScript(
        buildCosmeticAdBlockScript(
          privacySettings.adBlockerEnabled,
          privacySettings.adBlockerMode ?? 'standard'
        ),
        false
      )
      .catch(() => undefined)
  }, [privacySettings.adBlockerEnabled, privacySettings.adBlockerMode, privacySettings.siteInterventionsDisabled, tab.url])

  useEffect(() => {
    const webview = ref.current
    if (!webview || !domReadyRef.current) return
    const currentUrl = webview.getURL() || tab.url
    void window.vast.privacy.configureIdentity(webview.getWebContentsId(), identity, currentUrl, identitySeed).catch(() => undefined)
  }, [identity, identitySeed, privacySettings.webRtcExceptions, privacySettings.webRtcPolicy, tab.url])

  useEffect(() => {
    const webview = ref.current
    if (!webview || isInternalUrl(tab.url)) return
    if (guestNavigationUrlsRef.current.consume(tab.url)) return
    if (!domReadyRef.current) {
      pendingUrlRef.current = tab.url
      return
    }
    try {
      const currentUrl = webview.getURL()
      if (!currentUrl || currentUrl === tab.url) return
      void webview.loadURL(tab.url).catch((error) => {
        console.warn('[webview] Failed to navigate:', error)
      })
    } catch {
      pendingUrlRef.current = tab.url
    }
  }, [tab.url])

  useEffect(() => {
    const webview = ref.current
    if (!webview) return
    try {
      webview.setZoomFactor(tab.zoom)
    } catch (error) {
      console.warn('[webview] Failed to set zoom:', error)
    }
  }, [tab.zoom])

  useEffect(() => {
    const webview = ref.current as (Electron.WebviewTag & { setAudioMuted?: (muted: boolean) => void }) | null
    try {
      webview?.setAudioMuted?.(Boolean(tab.muted))
    } catch {
      // dom-ready will apply the stored muted state.
    }
  }, [tab.muted])

  return (
    <div
      className={`browser-webview-frame ${puristSafeSpace && puristSafeSpaceVisible ? 'is-purist-safe-space-visible' : ''}`}
      style={{
        display: visible ? 'grid' : 'none',
        width: '100%',
        height: '100%'
      }}
    >
      <div className="purist-scroll-safe-space" aria-hidden="true" />
      <webview
        ref={mountWebview}
        preload={window.vast.app.guestAutofillPreloadUrl}
        partition={partition}
        webpreferences="transparent=no"
        className="browser-webview"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}

export const WebviewSurface = memo(WebviewSurfaceComponent)
