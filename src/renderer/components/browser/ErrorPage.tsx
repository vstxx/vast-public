import { AlertTriangle, RotateCw } from 'lucide-react'
import type { Tab } from '../../../shared/types'
import { hostnameFor } from '../../lib/url'

export function ErrorPage({ tab, onReload }: { tab: Tab; onReload: () => void }): JSX.Element {
  const crashed = tab.lifecycle === 'crashed'
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#08090d]/95 p-8">
      <div className="max-w-xl rounded-panel border border-white/10 bg-white/[0.06] p-8 text-center shadow-glass">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-card border border-amber-300/25 bg-amber-300/10 text-amber-200">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="mt-5 text-2xl font-semibold text-white">
          {crashed ? 'This tab crashed' : `Could not open ${hostnameFor(tab.url) || 'this page'}`}
        </h2>
        <p className="mt-3 text-sm leading-6 text-vast-soft">
          {crashed
            ? 'The web page process stopped unexpectedly. Your URL is preserved and the rest of Vast is still running.'
            : `${tab.error?.description || 'The page failed to load.'} Vast blocked unsafe internal protocols and keeps web content isolated from the app.`}
        </p>
        <button
          type="button"
          onClick={onReload}
          className="vast-button vast-button--secondary vast-button--sm mt-6"
        >
          <RotateCw className="h-4 w-4" />
          {crashed ? 'Reload tab' : 'Try again'}
        </button>
      </div>
    </div>
  )
}
