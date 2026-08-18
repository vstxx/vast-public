import { Settings } from 'lucide-react'
import type { FeatureGate, FeatureState } from '../../../shared/feature-gates'
import { useBrowserStore } from '../../store/browser-store'
import { InternalPageHero, InternalPageShell } from './InternalPage'

export function FeatureGatePage({
  gate,
  featureState,
  labsEnabled
}: {
  gate: FeatureGate
  featureState: FeatureState
  labsEnabled: boolean
}): JSX.Element {
  const setSettingsOpen = useBrowserStore((state) => state.setSettingsOpen)
  const disabledByFlag = featureState.state === 'DisabledByFlag'
  const comingSoon = featureState.state === 'ComingSoon'
  const labsHidden = Boolean(gate.lab && !labsEnabled)
  const eyebrow = comingSoon ? 'Coming soon' : labsHidden ? 'Optional feature' : 'Vast Labs'
  const description = labsHidden ? `${gate.label} is not enabled.` : featureState.message

  const openFeatureSettings = (): void => {
    setSettingsOpen(true)
    const section = labsHidden ? 'Advanced' : 'Labs'
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('vast-open-settings-section', { detail: { section } })), 0)
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
            {labsHidden
              ? <>Optional features can be enabled from <span className="font-semibold text-white">Advanced settings</span>.</>
              : <>Enable <span className="font-semibold text-white">{gate.label}</span> in Labs settings to use this page.</>}
          </div>
        )}
      </InternalPageHero>
    </InternalPageShell>
  )
}
