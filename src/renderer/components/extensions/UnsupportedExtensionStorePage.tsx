import { Blocks, ExternalLink } from 'lucide-react'
import type { JSX } from 'react'
import { INTERNAL_EXTENSIONS_URL } from '../../../shared/constants'
import type { Tab } from '../../../shared/types'
import { useBrowserStore } from '../../store/browser-store'
import { VastButton } from '../ui/VastButton'

export function UnsupportedExtensionStorePage({ tab }: { tab: Tab }): JSX.Element {
  return (
    <div className="internal-page-shell grid place-items-center bg-[linear-gradient(180deg,#08090d,#050507)] p-6">
      <div className="vast-glass-panel max-w-xl rounded-panel p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-card border border-white/10 bg-white/[0.05] text-vast-accent">
          <Blocks className="h-7 w-7" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold text-white">Chrome Web Store is currently unsupported</h1>
        <p className="mt-3 text-sm leading-6 text-vast-soft">
          Chrome Web Store pages are not compatible with this Vast version. Install verified packages from Vast Extensions instead.
        </p>
        <div className="mt-6 flex justify-center">
          <VastButton onClick={() => useBrowserStore.getState().navigateTab(tab.id, INTERNAL_EXTENSIONS_URL)}>
            <ExternalLink className="h-4 w-4" />
            Open Vast Extensions
          </VastButton>
        </div>
      </div>
    </div>
  )
}
