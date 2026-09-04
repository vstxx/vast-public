import { KeyRound, X } from 'lucide-react'
import type { PasswordSavePromptAction, PasswordSavePromptPayload } from '../../../shared/types'

interface PasswordSavePromptProps {
  prompt: PasswordSavePromptPayload
  collapsed: boolean
  busy: boolean
  onCollapse: (collapsed: boolean) => void
  onAction: (action: PasswordSavePromptAction) => void
}

export function PasswordSavePrompt({ prompt, collapsed, busy, onCollapse, onAction }: PasswordSavePromptProps): JSX.Element {
  if (collapsed) {
    return (
      <button
        type="button"
        aria-label={`Open password prompt for ${prompt.hostname}`}
        title={`Password decision pending for ${prompt.hostname}`}
        data-testid="password-save-indicator"
        className="pointer-events-auto fixed right-5 top-[104px] z-[76] grid h-10 w-10 place-items-center rounded-xl bg-[#111218]/95 text-vast-cyan shadow-[0_14px_34px_rgba(0,0,0,0.42)] backdrop-blur-xl transition hover:bg-[#191a21] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/60"
        onClick={() => onCollapse(false)}
      >
        <KeyRound className="h-4 w-4" />
      </button>
    )
  }

  const title = prompt.action === 'update'
    ? 'Update saved password?'
    : prompt.kind === 'signup'
      ? 'Save this new account?'
      : 'Save password?'

  return (
    <aside
      aria-label="Password save prompt"
      data-testid="password-save-prompt"
      className="pointer-events-auto fixed right-5 top-[104px] z-[76] w-[min(380px,calc(100vw-2.5rem))] rounded-[20px] bg-[#0f1015]/[0.98] p-[18px] text-white shadow-[0_24px_70px_rgba(0,0,0,0.58)] backdrop-blur-2xl"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.055] text-vast-cyan">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-0.5 truncate text-xs text-vast-soft">{prompt.hostname}</div>
          <div className="mt-2 truncate text-sm text-white/85">{prompt.username || 'No username detected'}</div>
        </div>
        <button
          type="button"
          aria-label="Keep password decision for later"
          title="Keep for later"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/45 transition hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/70"
          onClick={() => onCollapse(true)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          data-testid="password-save-confirm"
          className="rounded-xl bg-vast-cyan px-4 py-2.5 text-xs font-semibold text-[#08090c] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/70"
          onClick={() => onAction(prompt.action)}
        >
          {prompt.action === 'update' ? 'Update' : 'Save'}
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="password-save-not-now"
          className="rounded-xl bg-white/[0.06] px-4 py-2.5 text-xs font-medium text-white/80 transition hover:bg-white/[0.1] hover:text-white disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/70"
          onClick={() => onAction('not-now')}
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="password-save-never"
          className="ml-auto rounded-lg px-2 py-2 text-[11px] text-vast-soft transition hover:bg-white/[0.05] hover:text-white disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/70"
          onClick={() => onAction('never')}
        >
          Never for this site
        </button>
      </div>
    </aside>
  )
}
