import { BROWSER_IMPORT_SOURCE_NAMES, browserImportProblemMessage, type BrowserImportCatalog, type BrowserImportDataType, type BrowserImportPreview, type BrowserImportSourceId } from '../../../shared/browser-import'
import chromeIcon from '../../../../assets/logos/onboarding/chrome.svg'
import edgeIcon from '../../../../assets/logos/onboarding/edge.png'
import firefoxIcon from '../../../../assets/logos/onboarding/firefox.png'
import { VastSelect } from '../ui/VastSelect'
import { Group, TogglePillRow, PillRow, type OnboardingPillOption } from './onboarding-ui'

export type OnboardingImportSource = BrowserImportSourceId | 'none'
export type OnboardingImportTypes = Record<BrowserImportDataType, boolean>

const IMPORT_TYPE_LABELS: Record<BrowserImportDataType, string> = {
  bookmarks: 'Bookmarks',
  history: 'History',
  extensions: 'Extensions'
}

const BROWSER_ICONS: Record<BrowserImportSourceId, string> = {
  chrome: chromeIcon,
  edge: edgeIcon,
  firefox: firefoxIcon
}

interface OnboardingImportStepProps {
  catalog: BrowserImportCatalog | null
  catalogError: string | null
  source: OnboardingImportSource
  profileId: string | null
  types: OnboardingImportTypes
  busy: boolean
  error: string | null
  preview: BrowserImportPreview | null
  acceptPartial: boolean
  onAcceptPartialChange: (accepted: boolean) => void
  onSourceChange: (source: OnboardingImportSource) => void
  onProfileChange: (profileId: string) => void
  onTypeToggle: (type: BrowserImportDataType) => void
  selectedExtensionIds: string[]
  onExtensionSelectionChange: (id: string, selected: boolean) => void
}

export function OnboardingImportStep({
  catalog,
  catalogError,
  source,
  profileId,
  types,
  busy,
  error,
  preview,
  acceptPartial,
  onAcceptPartialChange,
  onSourceChange,
  onProfileChange,
  onTypeToggle,
  selectedExtensionIds,
  onExtensionSelectionChange
}: OnboardingImportStepProps): JSX.Element {
  const selectedSource = source === 'none' ? undefined : catalog?.sources.find((entry) => entry.id === source)
  const sourceOptions: Array<OnboardingPillOption<OnboardingImportSource>> = [
    ...(catalog?.sources ?? []).map((entry) => ({
      id: entry.id,
      label: entry.name,
      iconUrl: BROWSER_ICONS[entry.id],
      disabled: busy || !entry.available,
      hint: entry.available ? undefined : `${entry.name} was not detected on this device.`
    })),
    { id: 'none', label: 'Fresh start', disabled: busy }
  ]

  return (
    <>
      <p className="onboarding-subtitle">Start fresh or preview bookmarks and history from another browser before saving them.</p>
      <div className="onboarding-setup-block">
        <Group label="Import from">
          <PillRow
            ariaLabel="Import from"
            wide
            value={source}
            options={sourceOptions}
            onChange={onSourceChange}
          />
          {catalogError && <div className="onboarding-note">{catalogError}</div>}
        </Group>
        {selectedSource?.available && selectedSource.profiles.length > 1 && (
          <Group label="Profile">
            <div className="onboarding-profile-select">
              <VastSelect
                value={profileId ?? selectedSource.profiles[0].id}
                options={selectedSource.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
                onChange={onProfileChange}
                ariaLabel="Browser profile"
                disabled={busy}
              />
            </div>
          </Group>
        )}
        <Group label="What to bring">
          <TogglePillRow
            ariaLabel="What to bring"
            value={(Object.keys(types) as BrowserImportDataType[]).filter((type) => types[type])}
            options={(Object.keys(IMPORT_TYPE_LABELS) as BrowserImportDataType[]).map((type) => ({
              id: type,
              label: IMPORT_TYPE_LABELS[type],
              disabled: busy || (type === 'extensions' && source === 'firefox')
            }))}
            onChange={onTypeToggle}
          />
        </Group>
        {source === 'firefox' && <div className="onboarding-note">Firefox extensions cannot be imported.</div>}
        {types.extensions && source !== 'firefox' && <div className="onboarding-note">Original Chrome/Edge extension files are copied only after data import and separate permission consent. They are Local / Unverified; private extension storage is not copied.</div>}
        {busy && <div className="onboarding-note" aria-live="polite">Preparing {source === 'none' ? 'browser' : BROWSER_IMPORT_SOURCE_NAMES[source]} preview…</div>}
        {preview && (
          <div className="onboarding-note" role="status" data-testid="onboarding-import-preview">
            Preview only — nothing has been saved yet. {preview.detected.bookmarks} bookmarks and {preview.detected.history} history entries detected.
            {Object.entries(preview.categories).filter(([kind, category]) => preview.selected.includes(kind as BrowserImportDataType) &&
              (category.status === 'failed' || category.status === 'unavailable')).map(([kind, category]) => (
              <div key={kind}>{kind}: {browserImportProblemMessage(category)}</div>
            ))}
            {preview.selected.includes('extensions') && <div>{preview.detected.extensions} extensions detected. Select each extension to review after the data commit.</div>}
            {preview.selected.includes('extensions') && preview.detectedExtensions.map((extension) => (
              <label key={extension.id} className="block py-1">
                <input type="checkbox" checked={selectedExtensionIds.includes(extension.id)}
                  disabled={busy || extension.state !== 'detected'}
                  onChange={(event) => onExtensionSelectionChange(extension.id, event.target.checked)} />{' '}
                {extension.name} {extension.version} · {extension.sourceEnabled ? 'Enabled in source' : 'Disabled in source'} · {extension.state === 'detected' ? 'Local / Unverified' : extension.state}
              </label>
            ))}
            {preview.selected.some((kind) => ['failed', 'unavailable'].includes(preview.categories[kind].status)) && (
              <label><input type="checkbox" checked={acceptPartial} onChange={(event) => onAcceptPartialChange(event.target.checked)} /> Continue with the available categories</label>
            )}
          </div>
        )}
        {error && <div className="onboarding-note onboarding-note--warning" role="alert">{error}</div>}
      </div>
    </>
  )
}
