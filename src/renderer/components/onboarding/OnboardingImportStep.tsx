import { BROWSER_IMPORT_SOURCE_NAMES, type BrowserImportCatalog, type BrowserImportDataType, type BrowserImportSourceId } from '../../../shared/browser-import'
import { VastSelect } from '../ui/VastSelect'
import { Group, TogglePillRow, PillRow, type OnboardingPillOption } from './onboarding-ui'

export type OnboardingImportSource = BrowserImportSourceId | 'none'
export type OnboardingImportTypes = Record<BrowserImportDataType, boolean>

const IMPORT_TYPE_LABELS: Record<BrowserImportDataType, string> = {
  bookmarks: 'Bookmarks',
  history: 'History',
  extensions: 'Extensions'
}

interface OnboardingImportStepProps {
  catalog: BrowserImportCatalog | null
  catalogError: string | null
  source: OnboardingImportSource
  profileId: string | null
  types: OnboardingImportTypes
  busy: boolean
  error: string | null
  onSourceChange: (source: OnboardingImportSource) => void
  onProfileChange: (profileId: string) => void
  onTypeToggle: (type: BrowserImportDataType) => void
}

export function OnboardingImportStep({
  catalog,
  catalogError,
  source,
  profileId,
  types,
  busy,
  error,
  onSourceChange,
  onProfileChange,
  onTypeToggle
}: OnboardingImportStepProps): JSX.Element {
  const selectedSource = source === 'none' ? undefined : catalog?.sources.find((entry) => entry.id === source)
  const sourceOptions: Array<OnboardingPillOption<OnboardingImportSource>> = [
    ...(catalog?.sources ?? []).map((entry) => ({
      id: entry.id,
      label: entry.name,
      disabled: !entry.available,
      hint: entry.available ? undefined : `${entry.name} was not detected on this device.`
    })),
    { id: 'none', label: 'Fresh start' }
  ]

  return (
    <>
      <p className="onboarding-subtitle">Start fresh or import bookmarks, history, and extensions from another browser.</p>
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
              disabled: busy
            }))}
            onChange={onTypeToggle}
          />
        </Group>
        {busy && <div className="onboarding-note" aria-live="polite">Importing from {source === 'none' ? 'browser' : BROWSER_IMPORT_SOURCE_NAMES[source]}…</div>}
        {error && <div className="onboarding-note onboarding-note--warning" role="alert">{error}</div>}
      </div>
    </>
  )
}
