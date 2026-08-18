import { ArrowLeftRight, X } from 'lucide-react'
import type { Tab } from '../../../shared/types'
import { displayUrl, isInternalUrl, webOriginFor } from '../../lib/url'
import { Favicon } from '../ui/Favicon'

export function SplitPaneHeader({
  tab,
  active,
  side,
  onActivate,
  onSwap,
  onExit
}: {
  tab: Tab
  active: boolean
  side: 'left' | 'right'
  onActivate: () => void
  onSwap: () => void
  onExit: () => void
}): JSX.Element {
  const subtitle = isInternalUrl(tab.url) ? 'Vast' : webOriginFor(tab.url)?.hostname ?? displayUrl(tab.url)
  return (
    <header
      className={`no-drag relative z-20 flex h-10 shrink-0 items-center gap-2 border-b px-2.5 transition-colors ${
        active
          ? 'border-vast-cyan/20 bg-[color-mix(in_srgb,var(--vast-accent)_7%,#090a0e)]'
          : 'border-white/[0.07] bg-[#090a0e]'
      }`}
      data-testid="split-pane-header"
      data-active={active ? 'true' : 'false'}
      data-side={side}
    >
      <button
        type="button"
        onClick={onActivate}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/65"
        title={`Focus ${tab.title}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-vast-cyan shadow-[0_0_10px_var(--vast-accent)]' : 'bg-white/20'}`} />
        <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs font-semibold ${active ? 'text-white' : 'text-vast-soft'}`}>{tab.title}</span>
          <span className="block truncate text-[10px] text-white/35">{subtitle}</span>
        </span>
      </button>
      {side === 'left' && (
        <button
          type="button"
          onClick={onSwap}
          title="Swap split panes"
          className="grid h-7 w-7 place-items-center rounded-lg text-white/35 transition hover:bg-white/[0.07] hover:text-white"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onExit}
        title="Exit split view"
        className="grid h-7 w-7 place-items-center rounded-lg text-white/35 transition hover:bg-white/[0.07] hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </header>
  )
}
