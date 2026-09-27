import { ArrowLeft, ArrowRight, Database, Sparkles, Wifi } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import vastIcon from '../../../../assets/logos/vasticon.png'
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
import type { BrowserImportCatalog, BrowserImportDataType, BrowserImportRunResult } from '../../../shared/browser-import'
import type { BrowserSettings } from '../../../shared/types'
import { useBrowserStore } from '../../store/browser-store'
import { matchesInternalUrl } from '../../lib/url'
import { VastButton } from '../ui/VastButton'
import { OnboardingExtensionsStep } from './OnboardingExtensionsStep'
import { OnboardingImportStep, type OnboardingImportSource, type OnboardingImportTypes } from './OnboardingImportStep'
import { AccentRow, Group, OnboardingToggleRow, PillRow, SummaryChip, ThemeChoiceGrid } from './onboarding-ui'

const MAX_STEP = 6
const LAB_STEPS: ReadonlyArray<{ key: 'avidae' | 'automation' | 'networkDevices' | 'advancedDiagnostics'; title: string; description: string; icon: JSX.Element }> = [
  { key: 'avidae', title: 'Video & Audio', description: 'Local media tools.', icon: <VideoAudioMark className="h-4 w-4" /> },
  { key: 'automation', title: 'Automation', description: 'Experimental local automation.', icon: <Sparkles className="h-4 w-4" /> },
  { key: 'networkDevices', title: 'Network Devices', description: 'Local network discovery.', icon: <Wifi className="h-4 w-4" /> },
  { key: 'advancedDiagnostics', title: 'Advanced Diagnostics', description: 'Extra diagnostic surfaces.', icon: <Database className="h-4 w-4" /> }
]

interface ImportSummary {
  sourceName: string
  bookmarksAdded: number
  historyAdded: number
  extensionsFound: number
  warnings: string[]
}

export function OnboardingPage(): JSX.Element {
  const settings = useBrowserStore((state) => state.settings)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const completeOnboarding = useBrowserStore((state) => state.completeOnboarding)
  const mergeImportedData = useBrowserStore((state) => state.mergeImportedData)

  const [step, setStep] = useState(0)
  const [completing, setCompleting] = useState(false)

  const [catalog, setCatalog] = useState<BrowserImportCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [source, setSource] = useState<OnboardingImportSource>('none')
  const [profileId, setProfileId] = useState<string | null>(null)
  const [types, setTypes] = useState<OnboardingImportTypes>({ bookmarks: true, history: true, extensions: true })
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const importedKeyRef = useRef<string | null>(null)
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
    () => onboardingSearchEngines().map((engine) => ({ id: engine.id, label: engine.name })),
    []
  )

  useEffect(() => {
    if (catalogRequestedRef.current) return
    catalogRequestedRef.current = true
    void window.vast.importer.discover().then((nextCatalog) => {
      setCatalog(nextCatalog)
    }).catch(() => setCatalogError('Browser detection is unavailable on this device.'))
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

  const applyDefaults = useCallback((): void => {
    const defaults = onboardingDefaultChoices()
    updateSettings({
      theme: defaults.theme,
      accentColor: defaults.accentColor,
      appearance: { cornerRadius: defaults.cornerRadius },
      defaultSearchEngine: defaults.defaultSearchEngine,
      newTab: { background: defaults.newTabBackground },
      labs: { enabled: false, avidae: false, automation: false, networkDevices: false, advancedDiagnostics: false }
    })
    setStep(MAX_STEP)
  }, [updateSettings])

  const runImport = useCallback(async (): Promise<boolean> => {
    if (source === 'none' || !selectedProfileId) return true
    const selectedTypes = (Object.keys(types) as BrowserImportDataType[]).filter((type) => types[type])
    if (selectedTypes.length === 0) return true
    if (importedKeyRef.current === importKey) return true
    setImportBusy(true)
    setImportError(null)
    try {
      const result: BrowserImportRunResult = await window.vast.importer.run({
        sourceId: source,
        profileId: selectedProfileId,
        types: selectedTypes
      })
      importedKeyRef.current = importKey
      if (!result.ok) {
        setImportError(result.error ?? 'The import failed. Your Vast data is untouched.')
        return false
      }
      const counts = mergeImportedData(result)
      const warnings = Object.values(result.categories)
        .map((category) => category.message)
        .filter((message): message is string => Boolean(message))
      if (result.bookmarks.length + result.history.length + result.extensions.length === 0) {
        setImportError('Nothing could be imported from this profile. You can try another browser or continue fresh.')
      }
      setImportSummary({
        sourceName: result.sourceName ?? 'browser',
        bookmarksAdded: counts.bookmarksAdded,
        historyAdded: counts.historyAdded,
        extensionsFound: result.extensions.length,
        warnings
      })
      return true
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The import failed. Your Vast data is untouched.')
      return false
    } finally {
      setImportBusy(false)
    }
  }, [importKey, mergeImportedData, selectedProfileId, source, types])

  const goNext = useCallback(async (): Promise<void> => {
    if (step === MAX_STEP || importBusy || completing) return
    if (step === 3) {
      const done = await runImport()
      if (!done) return
    }
    setStep((current) => Math.min(MAX_STEP, current + 1))
  }, [completing, importBusy, runImport, step])

  const goBack = useCallback((): void => {
    if (importBusy || completing) return
    setStep((current) => Math.max(0, current - 1))
  }, [completing, importBusy])

  const finish = useCallback(async (): Promise<void> => {
    if (completing) return
    setCompleting(true)
    try {
      completeOnboarding()
      const state = useBrowserStore.getState()
      const workspace = state.workspaces.find((entry) => entry.id === state.activeWorkspaceId)
      const tab = state.tabs.find((entry) => entry.id === workspace?.activeTabId)
      if (tab && matchesInternalUrl(tab.url, INTERNAL_ONBOARDING_URL)) {
        state.navigateTab(tab.id, INTERNAL_NEW_TAB_URL)
      }
      window.dispatchEvent(new Event('vast:persist-navigation'))
      await window.vast.storage.flush(useBrowserStore.getState().toPersistedData())
    } catch (error) {
      console.error('[onboarding] Completion could not be persisted:', error)
    } finally {
      setCompleting(false)
    }
  }, [completeOnboarding])

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
                onSourceChange={(next) => {
                  setSource(next)
                  setProfileId(null)
                  setImportError(null)
                }}
                onProfileChange={setProfileId}
                onTypeToggle={(type) => setTypes((current) => ({ ...current, [type]: !current[type] }))}
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
              <p className="onboarding-subtitle">All Labs are off by default.</p>
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
              <h2 className="onboarding-title">Setup complete.</h2>
              <div className="onboarding-summary-chips">
                <SummaryChip>{themeLabel}</SummaryChip>
                <SummaryChip>{engineName}</SummaryChip>
                {importSummary
                  ? <SummaryChip>{importSummary.bookmarksAdded + importSummary.historyAdded > 0 ? `${importSummary.bookmarksAdded} bookmarks · ${importSummary.historyAdded} history` : importSummary.sourceName}</SummaryChip>
                  : <SummaryChip>Fresh start</SummaryChip>}
                <SummaryChip>{extensionsAdded > 0 ? `${extensionsAdded} extension${extensionsAdded === 1 ? '' : 's'} added` : 'Extensions later'}</SummaryChip>
                <SummaryChip>{labsEnabled > 0 ? `${labsEnabled} Labs enabled` : 'Labs off'}</SummaryChip>
              </div>
              {importSummary && importSummary.warnings.length > 0 && (
                <div className="onboarding-note onboarding-note--warning" role="status">{importSummary.warnings[0]}</div>
              )}
              <div className="onboarding-actions">
                <VastButton variant="secondary" onClick={() => setStep(0)}>Restart</VastButton>
                <VastButton variant="primary" disabled={completing} data-testid="onboarding-enter-vast" icon={<ArrowRight className="h-4 w-4" />} onClick={() => void finish()}>
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
            {importBusy ? 'Importing…' : 'Next'}
          </VastButton>
        </nav>
      )}
    </div>
  )
}
