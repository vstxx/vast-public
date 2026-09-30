import { ArrowLeft, ArrowRight, Database, Sparkles, Wifi } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import vastIcon from '../../../../assets/logos/vasticon.png'
import googleIcon from '../../../../assets/logos/onboarding/google.png'
import duckDuckGoIcon from '../../../../assets/logos/onboarding/duckduckgo.png'
import braveSearchIcon from '../../../../assets/logos/onboarding/brave-search.svg'
import perplexityIcon from '../../../../assets/logos/onboarding/perplexity.svg'
import { VideoAudioMark } from '../avidae/VideoAudioBrand'
import {
  INTERNAL_NEW_TAB_URL,
  INTERNAL_ONBOARDING_URL,
  SEARCH_ENGINES
} from '../../../shared/constants'
import {
  ONBOARDING_BACKGROUNDS,
  ONBOARDING_RADIUS_MAX,
  ONBOARDING_RADIUS_MIN,
  onboardingDefaultChoices,
  onboardingSearchEngines
} from '../../../shared/onboarding'
import type { BrowserImportCatalog, BrowserImportCommitReceipt, BrowserImportDataType, BrowserImportExtensionReceipt, BrowserImportPreview } from '../../../shared/browser-import'
import type { ExtensionPackagePreview } from '../../../shared/extension-marketplace'
import type { BrowserSettings } from '../../../shared/types'
import { useBrowserStore } from '../../store/browser-store'
import { matchesInternalUrl } from '../../lib/url'
import { VastButton } from '../ui/VastButton'
import { OnboardingExtensionsStep } from './OnboardingExtensionsStep'
import { OnboardingImportStep, type OnboardingImportSource, type OnboardingImportTypes } from './OnboardingImportStep'
import { AccentRow, Group, OnboardingToggleRow, PillRow, SummaryChip, ThemeChoiceGrid } from './onboarding-ui'

const MAX_STEP = 6
const SEARCH_ENGINE_ICONS: Readonly<Record<string, string>> = {
  google: googleIcon,
  duckduckgo: duckDuckGoIcon,
  brave: braveSearchIcon,
  perplexity: perplexityIcon
}
const LAB_STEPS: ReadonlyArray<{ key: 'avidae' | 'automation' | 'networkDevices' | 'advancedDiagnostics' | 'spoofing'; title: string; description: string; icon: JSX.Element }> = [
  { key: 'avidae', title: 'Video & Audio', description: 'Local media tools.', icon: <VideoAudioMark className="h-4 w-4" /> },
  { key: 'automation', title: 'Automation', description: 'Experimental local automation.', icon: <Sparkles className="h-4 w-4" /> },
  { key: 'networkDevices', title: 'Network Devices', description: 'Local network discovery.', icon: <Wifi className="h-4 w-4" /> },
  { key: 'advancedDiagnostics', title: 'Advanced Diagnostics', description: 'Extra diagnostic surfaces.', icon: <Database className="h-4 w-4" /> },
  { key: 'spoofing', title: 'Spoofing', description: 'Optional privacy controls; no identity is changed until configured.', icon: <Sparkles className="h-4 w-4" /> }
]

interface ImportSummary {
  bookmarksAdded: number
  historyAdded: number
  skipped: number
  failed: number
}

export function OnboardingPage(): JSX.Element {
  const settings = useBrowserStore((state) => state.settings)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const completeOnboarding = useBrowserStore((state) => state.completeOnboarding)

  const [step, setStep] = useState(0)
  const [completing, setCompleting] = useState(false)
  const completingRef = useRef(false)

  const [catalog, setCatalog] = useState<BrowserImportCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [source, setSource] = useState<OnboardingImportSource>('none')
  const [profileId, setProfileId] = useState<string | null>(null)
  const [types, setTypes] = useState<OnboardingImportTypes>({ bookmarks: true, history: true, extensions: false })
  const [importBusy, setImportBusy] = useState(false)
  const importBusyRef = useRef(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<{ key: string; preview: BrowserImportPreview } | null>(null)
  const preparedRef = useRef<{ key: string; preview: BrowserImportPreview } | null>(null)
  const discardPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const [acceptPartial, setAcceptPartial] = useState(false)
  const [selectedExtensionIds, setSelectedExtensionIds] = useState<string[]>([])
  const [pendingExtensionIds, setPendingExtensionIds] = useState<string[]>([])
  const [extensionResults, setExtensionResults] = useState<BrowserImportExtensionReceipt[]>([])
  const [extensionPreview, setExtensionPreview] = useState<ExtensionPackagePreview | null>(null)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [extensionError, setExtensionError] = useState<string | null>(null)
  const [committedReceipt, setCommittedReceipt] = useState<BrowserImportCommitReceipt | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [extensionsAdded, setExtensionsAdded] = useState(0)
  const catalogRequestedRef = useRef(false)

  const theme = settings.theme === 'system' ? 'dark' : settings.theme
  const cornerRadius = settings.appearance.cornerRadius
  const selectedEngine = SEARCH_ENGINES.some((engine) => engine.id === settings.defaultSearchEngine)
    ? settings.defaultSearchEngine
    : null
  const selectedBackground = ONBOARDING_BACKGROUNDS.some((background) => background.id === settings.newTab.background)
    ? settings.newTab.background
    : null
  const searchOptions = useMemo(
    () => onboardingSearchEngines().map((engine) => ({ id: engine.id, label: engine.name, iconUrl: SEARCH_ENGINE_ICONS[engine.id] })),
    []
  )

  useEffect(() => {
    if (catalogRequestedRef.current) return
    catalogRequestedRef.current = true
    void window.vast.importer.discover().then((nextCatalog) => {
      setCatalog(nextCatalog)
    }).catch(() => setCatalogError('Browser detection is unavailable on this device.'))
  }, [])

  useEffect(() => {
    void window.vast.importer.status().then((status) => {
      if (status.receipt && !useBrowserStore.getState().onboarding?.completed) {
        setCommittedReceipt(status.receipt)
        setPendingExtensionIds(status.pendingExtensionIds)
        setExtensionResults(status.extensionReceipts)
        // A committed data import must always resume at the review/finish
        // screen, including after the last extension was installed.
        setStep(MAX_STEP)
        setImportSummary({
          bookmarksAdded: status.receipt.counts.bookmarks.added,
          historyAdded: status.receipt.counts.history.added,
          skipped: status.receipt.counts.bookmarks.skipped + status.receipt.counts.history.skipped,
          failed: status.receipt.counts.bookmarks.failed + status.receipt.counts.history.failed
        })
      }
    }).catch(() => undefined)
  }, [])

  const selectedProfileId = useMemo(() => {
    if (source === 'none') return null
    const profiles = catalog?.sources.find((entry) => entry.id === source)?.profiles ?? []
    if (profiles.length === 0) return null
    return profileId && profiles.some((profile) => profile.id === profileId) ? profileId : profiles[0].id
  }, [catalog, profileId, source])

  const importKey = source === 'none' || !selectedProfileId
    ? 'none'
    : `${source}:${selectedProfileId}:${(Object.keys(types) as BrowserImportDataType[]).filter((type) => types[type]).join(',')}`

  const discardPrepared = useCallback((): void => {
    const prior = preparedRef.current
    preparedRef.current = null
    setPrepared(null)
    setAcceptPartial(false)
    setSelectedExtensionIds([])
    if (prior) discardPromiseRef.current = window.vast.importer.discard(prior.preview.token).catch(() => undefined)
  }, [])

  const applyDefaults = useCallback((): void => {
    discardPrepared()
    setSource('none')
    const defaults = onboardingDefaultChoices()
    updateSettings({
      theme: defaults.theme,
      accentColor: defaults.accentColor,
      appearance: { cornerRadius: defaults.cornerRadius, cleanToolbarIcons: defaults.cleanToolbarIcons },
      defaultSearchEngine: defaults.defaultSearchEngine,
      newTab: { background: defaults.newTabBackground },
      labs: defaults.labs
    })
    setStep(MAX_STEP)
  }, [discardPrepared, updateSettings])

  const prepareImport = useCallback(async (): Promise<boolean> => {
    if (source === 'none' || !selectedProfileId) {
      discardPrepared()
      return true
    }
    const selectedTypes = (Object.keys(types) as BrowserImportDataType[]).filter((type) => types[type])
    if (selectedTypes.length === 0) {
      discardPrepared()
      return true
    }
    const current = preparedRef.current
    if (current?.key === importKey && current.preview.expiresAt > Date.now()) {
      if (current.preview.selected.some((type) => ['failed', 'unavailable'].includes(current.preview.categories[type].status)) && !acceptPartial) {
        setImportError('Some selected categories failed. Approve the partial import or choose another profile.')
        return false
      }
      return true
    }
    if (importBusyRef.current) return false
    importBusyRef.current = true
    setImportBusy(true)
    setImportError(null)
    try {
      discardPrepared()
      await discardPromiseRef.current
      const preview = await window.vast.importer.prepare({
        sourceId: source,
        profileId: selectedProfileId,
        types: selectedTypes
      })
      const next = { key: importKey, preview }
      preparedRef.current = next
      setPrepared(next)
      return false // A second explicit Next accepts the visible preview.
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The preview failed. Your Vast data is untouched.')
      return false
    } finally {
      importBusyRef.current = false
      setImportBusy(false)
    }
  }, [acceptPartial, discardPrepared, importKey, selectedProfileId, source, types])

  const goNext = useCallback(async (): Promise<void> => {
    if (step === MAX_STEP || importBusyRef.current || completingRef.current) return
    if (step === 3) {
      const done = await prepareImport()
      if (!done) return
    }
    setStep((current) => Math.min(MAX_STEP, current + 1))
  }, [prepareImport, step])

  const goBack = useCallback((): void => {
    if (importBusyRef.current || completingRef.current) return
    if (step === 3) discardPrepared()
    setStep((current) => Math.max(0, current - 1))
  }, [discardPrepared, step])

  const refreshExtensionImport = useCallback(async (): Promise<void> => {
    const data = await window.vast.storage.load()
    useBrowserStore.getState().hydrate(data)
    const status = await window.vast.importer.status()
    setPendingExtensionIds(status.pendingExtensionIds)
    setExtensionResults(status.extensionReceipts)
    setExtensionPreview(null)
  }, [])

  const prepareExtension = useCallback(async (): Promise<void> => {
    const id = pendingExtensionIds[0]
    if (!id || !committedReceipt || extensionBusy) return
    setExtensionBusy(true)
    setExtensionError(null)
    try {
      const preparedExtension = await window.vast.importer.prepareExtension(committedReceipt.operationId, id)
      if (preparedExtension.kind === 'preview') setExtensionPreview(preparedExtension.preview)
      else await refreshExtensionImport()
    } catch (error) { setExtensionError(error instanceof Error ? error.message : 'Extension preparation failed.') }
    finally { setExtensionBusy(false) }
  }, [committedReceipt, extensionBusy, pendingExtensionIds, refreshExtensionImport])

  const confirmExtension = useCallback(async (): Promise<void> => {
    const id = pendingExtensionIds[0]
    if (!id || !committedReceipt || !extensionPreview || extensionPreview.extensionId !== id || extensionBusy) return
    setExtensionBusy(true)
    setExtensionError(null)
    try {
      await window.vast.importer.confirmExtension({ operationId: committedReceipt.operationId,
        extensionId: id, token: extensionPreview.token, approval: extensionPreview.permissions })
      await refreshExtensionImport()
    } catch (error) { setExtensionError(error instanceof Error ? error.message : 'Extension installation failed.') }
    finally { setExtensionBusy(false) }
  }, [committedReceipt, extensionBusy, extensionPreview, pendingExtensionIds, refreshExtensionImport])

  const declineExtension = useCallback(async (): Promise<void> => {
    const id = pendingExtensionIds[0]
    if (!id || !committedReceipt || extensionBusy) return
    setExtensionBusy(true)
    setExtensionError(null)
    try {
      await window.vast.importer.declineExtension(committedReceipt.operationId, id)
      await refreshExtensionImport()
    } catch (error) { setExtensionError(error instanceof Error ? error.message : 'Could not skip extension.') }
    finally { setExtensionBusy(false) }
  }, [committedReceipt, extensionBusy, pendingExtensionIds, refreshExtensionImport])

  const finish = useCallback(async (): Promise<void> => {
    if (completingRef.current) return
    completingRef.current = true
    setCompleting(true)
    setFinishError(null)
    try {
      const currentPreview = preparedRef.current
      if (currentPreview && committedReceipt?.operationId !== currentPreview.preview.token) {
        if (currentPreview.preview.expiresAt <= Date.now()) throw new Error('Import preview expired. Go Back and prepare it again.')
        const beforeCommit = await window.vast.storage.flush(useBrowserStore.getState().toPersistedData())
        if (!beforeCommit.ok) throw new Error(beforeCommit.error ?? 'Could not save onboarding choices before import.')
        const receipt = await window.vast.importer.commit({
          token: currentPreview.preview.token,
          acceptPartial,
          selectedExtensionIds
        })
        setCommittedReceipt(receipt)
        const committed = await window.vast.storage.load()
        useBrowserStore.getState().hydrate(committed)
        setImportSummary({
          bookmarksAdded: receipt.counts.bookmarks.added,
          historyAdded: receipt.counts.history.added,
          skipped: receipt.counts.bookmarks.skipped + receipt.counts.history.skipped,
          failed: receipt.counts.bookmarks.failed + receipt.counts.history.failed
        })
        preparedRef.current = null
        setPrepared(null)
      }
      const importStatus = await window.vast.importer.status()
      setPendingExtensionIds(importStatus.pendingExtensionIds)
      setExtensionResults(importStatus.extensionReceipts)
      if (importStatus.pendingExtensionIds.length) return
      completeOnboarding()
      const state = useBrowserStore.getState()
      const completedSave = await window.vast.storage.flush(state.toPersistedData())
      if (!completedSave.ok) throw new Error(completedSave.error ?? 'Final onboarding save failed.')
      const workspace = state.workspaces.find((entry) => entry.id === state.activeWorkspaceId)
      const tab = state.tabs.find((entry) => entry.id === workspace?.activeTabId)
      if (tab && matchesInternalUrl(tab.url, INTERNAL_ONBOARDING_URL)) {
        state.navigateTab(tab.id, INTERNAL_NEW_TAB_URL)
      }
      window.dispatchEvent(new Event('vast:persist-navigation'))
      const navigationSave = await window.vast.storage.flush(useBrowserStore.getState().toPersistedData())
      if (!navigationSave.ok) throw new Error(navigationSave.error ?? 'Could not save final navigation.')
    } catch (error) {
      console.error('[onboarding] Completion could not be persisted:', error)
      setFinishError(error instanceof Error ? error.message : 'Setup could not be saved. Retry without repeating the import.')
      try { useBrowserStore.getState().hydrate(await window.vast.storage.load()) } catch { /* Keep the visible error. */ }
    } finally {
      completingRef.current = false
      setCompleting(false)
    }
  }, [acceptPartial, committedReceipt, completeOnboarding, selectedExtensionIds])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const target = event.target
      const onRange = target instanceof HTMLInputElement && target.type === 'range'
      if (event.key === 'Enter' && step === 0 && !(target instanceof HTMLButtonElement)) {
        setStep(1)
        return
      }
      if (event.key === 'ArrowRight' && step > 0 && step < MAX_STEP && !onRange) void goNext()
      if (event.key === 'ArrowLeft' && step > 0 && step < MAX_STEP && !onRange && !importBusy) goBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBack, goNext, importBusy, step])

  const themeLabel = theme[0].toUpperCase() + theme.slice(1)
  const engineName = SEARCH_ENGINES.find((engine) => engine.id === settings.defaultSearchEngine)?.name ?? settings.defaultSearchEngine
  const labsEnabled = LAB_STEPS.filter((lab) => settings.labs[lab.key]).length

  return (
    <div className="onboarding-page" data-testid="onboarding-page" data-onboarding-step={step}>
      <div className="onboarding-progress" aria-hidden="true"><span style={{ width: `${(step / MAX_STEP) * 100}%` }} /></div>
      <main className="onboarding-viewport">
        <div className="onboarding-stage">
          {step === 0 && (
            <section className="onboarding-content onboarding-content--narrow" data-onboarding-step-content="0">
              <img className="onboarding-logo" src={vastIcon} alt="Vast" draggable={false} />
              <h1 className="onboarding-title onboarding-title--welcome">Set up Vast.</h1>
              <div className="onboarding-actions">
                <VastButton variant="secondary" data-testid="onboarding-use-defaults" onClick={applyDefaults}>Use defaults</VastButton>
                <VastButton variant="primary" data-testid="onboarding-configure" icon={<ArrowRight className="h-4 w-4" />} onClick={() => setStep(1)}>Configure</VastButton>
              </div>
            </section>
          )}
          {step === 1 && (
            <section className="onboarding-content" data-onboarding-step-content="1">
              <h2 className="onboarding-title">Appearance</h2>
              <div className="onboarding-setup-block">
                <Group label="Theme">
                  <ThemeChoiceGrid
                    value={theme}
                    onChange={(selected) => updateSettings({ theme: selected as typeof settings.theme })}
                  />
                </Group>
                <Group label="Accent">
                  <AccentRow value={settings.accentColor} onChange={(accentColor) => updateSettings({ accentColor })} />
                </Group>
                <Group label="Corner radius">
                  <label className="onboarding-radius">
                    <span className="settings-range-control">
                      <input
                        type="range"
                        min={ONBOARDING_RADIUS_MIN}
                        max={ONBOARDING_RADIUS_MAX}
                        value={Math.min(ONBOARDING_RADIUS_MAX, Math.max(ONBOARDING_RADIUS_MIN, cornerRadius))}
                        aria-label="Corner radius"
                        onChange={(event) => updateSettings({ appearance: { cornerRadius: Number(event.target.value) } })}
                        style={{ '--range-progress': `${((Math.min(ONBOARDING_RADIUS_MAX, Math.max(ONBOARDING_RADIUS_MIN, cornerRadius)) - ONBOARDING_RADIUS_MIN) / (ONBOARDING_RADIUS_MAX - ONBOARDING_RADIUS_MIN)) * 100}%` } as CSSProperties}
                      />
                      <output>{Math.min(ONBOARDING_RADIUS_MAX, Math.max(ONBOARDING_RADIUS_MIN, cornerRadius))} px</output>
                    </span>
                  </label>
                </Group>
              </div>
            </section>
          )}
          {step === 2 && (
            <section className="onboarding-content" data-onboarding-step-content="2">
              <h2 className="onboarding-title">Search and new tab</h2>
              <div className="onboarding-setup-block">
                <Group label="Search engine">
                  <PillRow
                    ariaLabel="Search engine"
                    wide
                    value={selectedEngine}
                    options={searchOptions}
                    onChange={(defaultSearchEngine) => updateSettings({ defaultSearchEngine })}
                  />
                </Group>
                <Group label="New tab background">
                  <PillRow
                    ariaLabel="New tab background"
                    wide
                    value={selectedBackground}
                    options={ONBOARDING_BACKGROUNDS}
                    onChange={(background) => updateSettings({ newTab: { background } })}
                  />
                </Group>
              </div>
            </section>
          )}
          {step === 3 && (
            <section className="onboarding-content" data-onboarding-step-content="3">
              <h2 className="onboarding-title">Import</h2>
              <OnboardingImportStep
                catalog={catalog}
                catalogError={catalogError}
                source={source}
                profileId={selectedProfileId}
                types={types}
                busy={importBusy}
                error={importError}
                preview={prepared?.key === importKey ? prepared.preview : null}
                acceptPartial={acceptPartial}
                onAcceptPartialChange={setAcceptPartial}
                selectedExtensionIds={selectedExtensionIds}
                onExtensionSelectionChange={(id, selected) => setSelectedExtensionIds((current) =>
                  selected ? [...new Set([...current, id])] : current.filter((item) => item !== id))}
                onSourceChange={(next) => {
                  if (importBusyRef.current || completingRef.current) return
                  discardPrepared()
                  setSource(next)
                  if (next === 'firefox') setTypes((current) => ({ ...current, extensions: false }))
                  setProfileId(null)
                  setImportError(null)
                }}
                onProfileChange={(next) => {
                  if (importBusyRef.current || completingRef.current) return
                  discardPrepared()
                  setProfileId(next)
                }}
                onTypeToggle={(type) => {
                  if (importBusyRef.current || completingRef.current || (type === 'extensions' && source === 'firefox')) return
                  discardPrepared()
                  setTypes((current) => ({ ...current, [type]: !current[type] }))
                }}
              />
            </section>
          )}
          {step === 4 && (
            <section className="onboarding-content onboarding-content--wide" data-onboarding-step-content="4">
              <h2 className="onboarding-title">Extensions</h2>
              <OnboardingExtensionsStep onInstalledCountChange={setExtensionsAdded} />
            </section>
          )}
          {step === 5 && (
            <section className="onboarding-content onboarding-content--narrow" data-onboarding-step-content="5">
              <h2 className="onboarding-title">Labs</h2>
              <p className="onboarding-subtitle">Labs are on by default. Network scanning still needs separate permission.</p>
              <div className="onboarding-setup-block">
                <Group label="Vast Labs">
                  <div className="onboarding-rows">
                    {LAB_STEPS.map((lab) => (
                      <OnboardingToggleRow
                        key={lab.key}
                        icon={lab.icon}
                        title={lab.title}
                        description={lab.description}
                        checked={settings.labs[lab.key]}
                        onChange={(checked) => updateSettings({ labs: { [lab.key]: checked } as Partial<BrowserSettings['labs']> })}
                      />
                    ))}
                  </div>
                </Group>
              </div>
            </section>
          )}
          {step === MAX_STEP && (
            <section className="onboarding-content onboarding-content--narrow" data-onboarding-step-content="6">
              <img className="onboarding-logo onboarding-logo--ready" src={vastIcon} alt="Vast" draggable={false} />
              <h2 className="onboarding-title">{pendingExtensionIds.length ? 'Review imported extensions' : 'Setup complete.'}</h2>
              <div className="onboarding-summary-chips">
                <SummaryChip>{themeLabel}</SummaryChip>
                <SummaryChip>{engineName}</SummaryChip>
                {importSummary
                  ? <SummaryChip>{`${importSummary.bookmarksAdded} bookmarks · ${importSummary.historyAdded} history saved`}</SummaryChip>
                  : prepared
                    ? <SummaryChip>{`Preview: ${prepared.preview.detected.bookmarks} bookmarks · ${prepared.preview.detected.history} history`}</SummaryChip>
                    : <SummaryChip>{committedReceipt ? 'Import saved' : 'Fresh start'}</SummaryChip>}
                <SummaryChip>{extensionsAdded > 0 ? `${extensionsAdded} extension${extensionsAdded === 1 ? '' : 's'} added` : 'Extensions later'}</SummaryChip>
                <SummaryChip>{labsEnabled > 0 ? `${labsEnabled} Labs enabled` : 'Labs off'}</SummaryChip>
              </div>
              {importSummary && (importSummary.skipped > 0 || importSummary.failed > 0) && (
                <div className="onboarding-note" role="status">{importSummary.skipped} skipped · {importSummary.failed} failed</div>
              )}
              {extensionResults.length > 0 && <div className="onboarding-note" role="status">
                Extension transfer: {extensionResults.map((item) => `${item.id.slice(0, 8)}: ${item.status}${item.message ? ` (${item.message})` : ''}`).join(' · ')}
              </div>}
              {finishError && <div className="onboarding-note onboarding-note--warning" role="alert">{finishError}</div>}
              {pendingExtensionIds.length > 0 && <div className="onboarding-setup-block" data-testid="onboarding-extension-consent">
                <div className="onboarding-note">Bookmarks and history are already saved. Review each local extension separately; skipping or a failed extension will not roll back that data. {pendingExtensionIds.length} remaining.</div>
                {extensionPreview?.extensionId === pendingExtensionIds[0] ? <div className="onboarding-note">
                  <div>{extensionPreview.name} {extensionPreview.version} · Local / Unverified · {extensionPreview.sourceEnabled ? 'Enabled in source' : 'Disabled in source'}</div>
                  <div>Original extension ID: {extensionPreview.extensionId}</div>
                  <div>Compatibility: {extensionPreview.compatibility ?? 'Not verified'}</div>
                  <div>Required Chrome permissions: {extensionPreview.permissions.chrome.join(', ') || 'none'}</div>
                  <div>Required website access: {extensionPreview.permissions.hosts.join(', ') || 'none'}</div>
                  <div>Vast Native permissions: none</div>
                  {extensionPreview.limitations?.map((limitation) => <div key={limitation}>{limitation}</div>)}
                </div> : <div className="onboarding-note">Extension ID: {pendingExtensionIds[0]}</div>}
                {extensionError && <div className="onboarding-note onboarding-note--warning" role="alert">{extensionError}</div>}
                <div className="onboarding-actions">
                  <VastButton variant="secondary" disabled={extensionBusy} onClick={() => void declineExtension()}>Skip extension</VastButton>
                  {extensionPreview?.extensionId === pendingExtensionIds[0]
                    ? <VastButton variant="primary" disabled={extensionBusy} onClick={() => void confirmExtension()}>Install and approve listed permissions</VastButton>
                    : <VastButton variant="primary" disabled={extensionBusy} onClick={() => void prepareExtension()}>Review extension</VastButton>}
                </div>
              </div>}
              <div className="onboarding-actions">
                {!committedReceipt && <VastButton variant="secondary" disabled={completing} onClick={() => {
                  discardPrepared()
                  setSource('none')
                  setProfileId(null)
                  setImportError(null)
                  setFinishError(null)
                  setStep(0)
                }}>Restart</VastButton>}
                <VastButton variant="primary" disabled={completing || pendingExtensionIds.length > 0} data-testid="onboarding-enter-vast" icon={<ArrowRight className="h-4 w-4" />} onClick={() => void finish()}>
                  {completing ? 'Configured' : 'Enter Vast'}
                </VastButton>
              </div>
            </section>
          )}
        </div>
      </main>
      {step > 0 && step < MAX_STEP && (
        <nav className="onboarding-nav" aria-label="Onboarding navigation">
          <VastButton variant="secondary" icon={<ArrowLeft className="h-4 w-4" />} disabled={importBusy || completing} onClick={goBack}>
            Back
          </VastButton>
          <VastButton variant="primary" icon={importBusy ? undefined : <ArrowRight className="h-4 w-4" />} disabled={importBusy || completing} onClick={() => void goNext()}>
            {importBusy ? 'Preparing…' : step === 3 && source !== 'none' && !prepared ? 'Review import' : 'Next'}
          </VastButton>
        </nav>
      )}
    </div>
  )
}
