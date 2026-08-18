import { AlertTriangle, CheckCircle2, Download, Info, LoaderCircle, MonitorUp, ShieldAlert, X } from 'lucide-react'
import type { DownloadItem, UiNotificationPayload, UiPromptPayload } from '../../../shared/types'
import { formatBytes } from '../../lib/format'
import { ModalShell } from './ModalShell'
import { NotificationCard } from './NotificationCard'

type ToastItem = UiNotificationPayload & { createdAt: number }

function toneIcon(tone: UiNotificationPayload['tone']): JSX.Element {
  if (tone === 'success') return <CheckCircle2 className="h-5 w-5 text-emerald-300" />
  if (tone === 'warning') return <AlertTriangle className="h-5 w-5 text-amber-300" />
  if (tone === 'error') return <ShieldAlert className="h-5 w-5 text-rose-300" />
  return <Info className="h-5 w-5 text-sky-300" />
}

function toneStyles(tone: UiNotificationPayload['tone']): string {
  if (tone === 'success') return 'border-emerald-400/20 bg-[linear-gradient(180deg,rgba(8,18,16,0.98),rgba(7,12,12,0.96))] shadow-[0_24px_60px_rgba(16,185,129,0.12)]'
  if (tone === 'warning') return 'border-amber-400/20 bg-[linear-gradient(180deg,rgba(24,17,10,0.98),rgba(12,10,8,0.96))] shadow-[0_24px_60px_rgba(245,158,11,0.14)]'
  if (tone === 'error') return 'border-rose-400/20 bg-[linear-gradient(180deg,rgba(24,10,12,0.98),rgba(12,8,9,0.96))] shadow-[0_24px_60px_rgba(244,63,94,0.16)]'
  return 'border-sky-400/20 bg-[linear-gradient(180deg,rgba(9,15,21,0.98),rgba(7,10,14,0.96))] shadow-[0_24px_60px_rgba(56,189,248,0.12)]'
}

function promptActionStyles(tone: NonNullable<UiPromptPayload['actions'][number]['tone']> | undefined): string {
  if (tone === 'primary') return 'border-transparent bg-vast-cyan text-black hover:bg-white'
  if (tone === 'success') return 'border-transparent bg-emerald-300 text-black hover:bg-emerald-200'
  if (tone === 'danger') return 'border-rose-400/20 bg-rose-500/12 text-rose-100 hover:bg-rose-500/18'
  return 'border-white/10 bg-white/[0.045] text-vast-soft hover:bg-white/[0.08] hover:text-white'
}

export function NotificationsOverlay({
  toasts,
  downloads,
  onDismiss
}: {
  toasts: ToastItem[]
  downloads: DownloadItem[]
  onDismiss: (id: string) => void
}): JSX.Element | null {
  const activeDownloads = downloads
    .filter((item) => item.state === 'progressing')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)

  if (activeDownloads.length === 0 && toasts.length === 0) return null

  return (
    <div className="vast-notification-stack pointer-events-none fixed right-5 top-5 z-[65] flex flex-col gap-3" aria-live="polite">
      {activeDownloads.map((item) => {
        const progress = item.totalBytes > 0 ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : undefined
        return (
          <NotificationCard
            key={`download-${item.id}`}
            className="download-progress-toast pointer-events-auto overflow-hidden border border-white/10 bg-[#0b0c10]/[0.97] shadow-[0_18px_48px_rgba(0,0,0,0.34)]"
          >
            <div className="flex items-start gap-3">
              <div className="vast-notification-icon mt-0.5 border border-white/10 bg-white/[0.05] text-vast-soft">
                <LoaderCircle className="h-5 w-5 animate-spin" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">Downloading</div>
                    <div className="vast-notification-message truncate">{item.filename}</div>
                  </div>
                  <div className="shrink-0 text-xs font-medium text-vast-soft">
                    {progress !== undefined ? `${progress}%` : 'Active'}
                  </div>
                </div>
                <div className="mt-2 text-xs text-white/[0.45]">
                  {formatBytes(item.receivedBytes)}{item.totalBytes > 0 ? ` of ${formatBytes(item.totalBytes)}` : ' received'}
                </div>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full rounded-full bg-white/[0.55] transition-[width] duration-300 ease-out"
                    style={{ width: `${progress ?? 18}%` }}
                  />
                </div>
              </div>
            </div>
          </NotificationCard>
        )
      })}

      {toasts.map((toast) => (
        <NotificationCard
          key={toast.id}
          className={`pointer-events-auto overflow-hidden border backdrop-blur-2xl ${toneStyles(toast.tone)}`}
        >
          <div className="flex items-start gap-3">
            <div className="vast-notification-icon mt-0.5 border border-white/10 bg-white/[0.05]">
              {toneIcon(toast.tone)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">{toast.title}</div>
                  <div className="vast-notification-message">{toast.message}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onDismiss(toast.id)}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-vast-soft transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {toast.detail && (
                <div className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs leading-5 text-vast-soft">
                  {toast.detail}
                </div>
              )}
              {toast.actions && toast.actions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {toast.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      className="rounded-xl border border-vast-cyan/25 bg-vast-cyan/10 px-3 py-1.5 text-xs font-semibold text-vast-cyan transition-colors hover:bg-vast-cyan/20"
                      onClick={action.action}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </NotificationCard>
      ))}
    </div>
  )
}

export function ActionPromptModal({
  prompt,
  onResolve
}: {
  prompt: UiPromptPayload | null
  onResolve: (actionId: string) => void
}): JSX.Element | null {
  if (!prompt) return null

  const closeAction = prompt.actions[prompt.actions.length - 1]?.id
  const toneIconElement =
    prompt.choices?.length
      ? <MonitorUp className="h-5 w-5 text-vast-cyan" />
      : prompt.tone === 'danger'
      ? <ShieldAlert className="h-5 w-5 text-rose-300" />
      : prompt.tone === 'warning'
        ? <AlertTriangle className="h-5 w-5 text-amber-300" />
        : <Download className="h-5 w-5 text-vast-cyan" />

  return (
    <ModalShell onClose={() => closeAction && onResolve(closeAction)} width={prompt.choices?.length ? 'max-w-4xl' : 'max-w-lg'}>
      <div className="p-5">
        <div className="flex items-start gap-4">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/[0.05]">
            {toneIconElement}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold text-white">{prompt.title}</div>
            <div className="mt-2 text-sm leading-6 text-white/90">{prompt.message}</div>
            {prompt.detail && <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-vast-soft">{prompt.detail}</div>}
          </div>
        </div>

        {prompt.choices && prompt.choices.length > 0 && (
          <div className="mt-5 grid max-h-[52vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3" data-testid="prompt-choice-grid">
            {prompt.choices.map((choice) => (
              <div key={choice.id} className="overflow-hidden rounded-2xl border border-white/10 bg-black/25 transition hover:border-vast-cyan/35 hover:bg-white/[0.045]">
                <button
                  type="button"
                  onClick={() => onResolve(choice.id)}
                  className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-vast-cyan/70"
                  data-testid="prompt-choice"
                >
                  <div className="aspect-video w-full overflow-hidden bg-black/45">
                    {choice.thumbnailDataUrl ? (
                      <img src={choice.thumbnailDataUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="grid h-full place-items-center"><MonitorUp className="h-8 w-8 text-white/25" /></div>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="truncate text-sm font-semibold text-white">{choice.label}</div>
                    {choice.detail && <div className="mt-0.5 text-xs text-vast-soft">{choice.detail}</div>}
                  </div>
                </button>
                {choice.alternateAction && (
                  <button
                    type="button"
                    onClick={() => onResolve(choice.alternateAction!.id)}
                    className="mx-3 mb-3 w-[calc(100%-1.5rem)] rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2 text-xs font-medium text-vast-soft transition hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vast-cyan/70"
                  >
                    {choice.alternateAction.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {prompt.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onResolve(action.id)}
              className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${promptActionStyles(action.tone)}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </ModalShell>
  )
}
