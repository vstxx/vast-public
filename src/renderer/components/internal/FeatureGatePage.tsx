import { Settings } from 'lucide-react'
import type { FeatureGate, FeatureState } from '../../../shared/feature-gates'
import { useBrowserStore } from '../../store/browser-store'
import { InternalPageHero, InternalPageShell } from './InternalPage'

export function FeatureGatePage({
  gate,
  featureState
}: {
  gate: FeatureGate
  featureState: FeatureState
}): JSX.Element {
  const setSettingsOpen = useBrowserStore((state) => state.setSettingsOpen)
  const disabledByFlag = featureState.state === 'DisabledByFlag'
  const comingSoon = featureState.state === 'ComingSoon'
  const eyebrow = comingSoon ? 'Coming soon' : 'Vast Labs'
  const description = featureState.message

  const openFeatureSettings = (): void => {
    setSettingsOpen(true)
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('vast-open-settings-section', { detail: { section: 'Labs' } })), 0)
  }

  return (
    <InternalPageShell className="bg-[linear-gradient(180deg,#08090d,#050507)] p-5">
      <InternalPageHero
        icon={Settings}
        eyebrow={eyebrow}
        title={gate.label}
        description={description}
        actions={
          disabledByFlag ? (
            <button type="button" className="settings-action" onClick={openFeatureSettings}>
              <Settings className="h-4 w-4" />
              Open Settings
            </button>
          ) : undefined
        }
      >
        {disabledByFlag && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-sm text-vast-soft">
            Enable <span className="font-semibold text-white">{gate.label}</span> in Labs settings to use this page.
          </div>
        )}
      </InternalPageHero>
    </InternalPageShell>
  )
}
