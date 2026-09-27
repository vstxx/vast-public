import { Puzzle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ExtensionPackagePreview, VastHubCatalogItem } from '../../../shared/extension-marketplace'
import { useVastConfirm } from '../ui/useVastConfirm'
import { VastButton } from '../ui/VastButton'
import { Group } from './onboarding-ui'

const RECOMMENDED_SLOTS = 6

function installSummary(preview: ExtensionPackagePreview): string {
  const access = [...preview.permissions.chrome, ...preview.permissions.hosts, ...preview.permissions.vast]
  const trust = preview.trust === 'official' ? `Verified Vast package from ${preview.publisherName}.` : 'Local package. Vast Extensions has not authenticated its publisher.'
  return `${trust}\n\nRequested access:\n${access.length > 0 ? access.map((item) => `• ${item}`).join('\n') : '• No additional browser or Vast permissions'}`
}

interface OnboardingExtensionsStepProps {
  onInstalledCountChange: (count: number) => void
}

export function OnboardingExtensionsStep({ onInstalledCountChange }: OnboardingExtensionsStepProps): JSX.Element {
  const confirm = useVastConfirm()
  const [items, setItems] = useState<VastHubCatalogItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(new Set())
  const requestedRef = useRef(false)
  const installedCount = addedIds.size

  useEffect(() => {
    onInstalledCountChange(installedCount)
  }, [installedCount, onInstalledCountChange])

  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    void window.vast.extensions.catalog({ page: 1, sort: 'popular' }).then((result) => {
      if (result.ok && result.catalog) {
        const recommended = result.catalog.featured.length > 0 ? result.catalog.featured : result.catalog.items
        setItems(recommended.slice(0, RECOMMENDED_SLOTS))
      } else {
        setError(result.error ?? 'Vast Extensions is unavailable right now.')
      }
    }).catch(() => setError('Vast Extensions is unavailable right now.'))
  }, [])

  const install = async (item: VastHubCatalogItem): Promise<void> => {
    setBusyId(item.id)
    setError(null)
    try {
      const prepared = await window.vast.extensions.prepareHubInstall(item.id)
      if (!prepared.ok || !prepared.preview) {
        setError(prepared.error ?? 'Could not prepare the installation.')
        return
      }
      const preview = prepared.preview
      const approved = await confirm(`Install ${preview.name}?`, installSummary(preview), 'Install')
      if (!approved) {
        await window.vast.extensions.cancelInstall(preview.token)
        return
      }
      const result = await window.vast.extensions.confirmInstall(preview.token)
      if (!result.ok) {
        setError(result.error ?? 'The installation failed.')
        return
      }
      setAddedIds((current) => new Set(current).add(item.id))
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : 'The installation failed.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <p className="onboarding-subtitle">Install now or later from the Extensions Hub.</p>
      <div className="onboarding-setup-block">
        <Group label="Recommended from Extensions Hub">
          {items.length > 0 && (
            <div className="onboarding-extension-grid">
              {items.map((item) => {
                const added = addedIds.has(item.id) || item.installed
                return (
                  <article key={item.id} className={`onboarding-extension-slot ${added ? 'is-added' : ''}`} data-extension-id={item.id}>
                    <div className="onboarding-extension-head">
                      <span className="onboarding-extension-icon">
                        {item.iconUrl ? <img src={item.iconUrl} alt="" className="h-5 w-5 object-contain" /> : <Puzzle className="h-4 w-4" />}
                      </span>
                      <span className="onboarding-extension-meta">
                        <span className="onboarding-extension-title">{item.name}</span>
                        <span className="onboarding-extension-sub">{item.publisher.name}{item.publisher.verified ? ' · Verified' : ''}</span>
                      </span>
                    </div>
                    <div className="onboarding-extension-bottom">
                      <span className="onboarding-hub-label">Extensions Hub</span>
                      <VastButton
                        size="sm"
                        variant={added ? 'selected' : 'secondary'}
                        disabled={busyId === item.id || added}
                        aria-label={`Install ${item.name}`}
                        onClick={() => void install(item)}
                      >
                        {added ? 'Added' : 'Install'}
                      </VastButton>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
          {items.length === 0 && !error && <div className="onboarding-note">Loading recommendations…</div>}
          {items.length === 0 && error && (
            <div className="onboarding-note onboarding-note--warning">
              {error} You can finish setup without it — extensions are always available later.
            </div>
          )}
          {items.length > 0 && error && <div className="onboarding-note onboarding-note--warning" role="alert">{error}</div>}
        </Group>
      </div>
    </>
  )
}
