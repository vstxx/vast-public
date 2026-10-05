import { AlertTriangle, CheckCircle2, Loader2, Play, Square, Terminal } from 'lucide-react'
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useBrowserRuntime } from '../../app/browser-runtime'
import type { AvidaeStatus } from '../../../shared/types'
import { VideoAudioBrand, VideoAudioMark } from './VideoAudioBrand'

function statusLabel(state: AvidaeStatus['state']): string {
  if (state === 'running') return 'Video & Audio backend running'
  if (state === 'starting') return 'Starting Video & Audio backend'
  if (state === 'installing') return 'Installing Video & Audio dependencies'
  if (state === 'error') return 'Video & Audio backend needs attention'
  return 'Video & Audio backend stopped'
}

export function AvidaePage(): JSX.Element {
  const runtime = useBrowserRuntime()
  const [status, setStatus] = useState<AvidaeStatus | null>(null)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<AvidaeStatus> => {
    const next = await window.vast.avidae.status()
    startTransition(() => setStatus(next))
    return next
  }, [])

  const start = useCallback(async (): Promise<void> => {
    setBusy(true)
    setIframeLoaded(false)
    try {
      const next = await window.vast.avidae.start()
      startTransition(() => setStatus(next))
    } finally {
      setBusy(false)
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    setBusy(true)
    setIframeLoaded(false)
    try {
      const next = await window.vast.avidae.stop()
      startTransition(() => setStatus(next))
    } finally {
      setBusy(false)
    }
  }, [])

  const installDependencies = useCallback(async (): Promise<void> => {
    setBusy(true)
    setIframeLoaded(false)
    try {
      const next = await window.vast.avidae.installDependencies()
      startTransition(() => setStatus(next))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.vast.avidae.status().then((next) => {
      if (!cancelled) startTransition(() => setStatus(next))
    })
    const timer = window.setInterval(() => {
      void window.vast.avidae.status().then((next) => {
        if (!cancelled) startTransition(() => setStatus(next))
      })
    }, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const logs = useMemo(() => (status?.logs ?? []).slice(-12), [status?.logs])
  const runningUrl = status?.state === 'running' ? status.url : undefined

  if (runningUrl) {
    return (
      <div className="relative h-full min-h-[560px] overflow-hidden bg-vast-black">
        {!iframeLoaded && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-vast-black">
            <div className="rounded-panel border border-white/10 bg-white/5.5 px-6 py-5 text-center shadow-glass backdrop-blur-2xl">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-vast-cyan" />
              <VideoAudioMark className="mx-auto mt-4 h-9 w-9" />
              <div className="mt-2 text-sm font-semibold text-white">Loading Video &amp; Audio</div>
              <div className="mt-1 text-xs text-vast-soft">{runningUrl}</div>
            </div>
          </div>
        )}
        <iframe
          title="Video & Audio"
          src={runningUrl}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setIframeLoaded(true)}
          className="h-full w-full border-0 bg-vast-black"
        />
      </div>
    )
  }

  return (
    <div className="labs-page-surface min-h-full overflow-auto bg-[#06070a] p-6 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-160px)] w-full max-w-5xl items-center justify-center">
        <section className="vast-glass-panel w-full overflow-hidden rounded-modal p-6 shadow-[0_32px_120px_rgba(0,0,0,0.4)] md:p-8">
          <div className="space-y-6">
            <div className="max-w-2xl">
              <VideoAudioBrand
                className="w-full max-w-164"
              />
              <div className="mt-3 flex items-center gap-2 text-[13px] font-medium text-vast-soft">
                {status?.state === 'error' ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-vast-amber" />
                ) : status?.state === 'stopped' ? (
                  <Square className="h-3.5 w-3.5 text-vast-soft" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-vast-cyan" />
                )}
                {statusLabel(status?.state ?? 'starting')}
              </div>
              <p className="mt-4 text-sm leading-7 text-vast-soft md:text-base">
                Edit, convert, record and download video and audio — all in one place.
              </p>
              <p className="mt-2 text-[13px] leading-6 text-vast-soft">
                Video &amp; Audio is experimental Labs software, please report any bugs on our{" "}
                <button
                  type="button"
                  onClick={() => runtime.openUrlInNewTab('https://discord.gg/QmQ54MArrB')}
                  className="font-semibold text-vast-cyan underline decoration-vast-cyan/40 underline-offset-2 hover:decoration-vast-cyan"
                >
                  Discord
                </button>
              </p>
              {status?.error && (
                <div className="mt-5 rounded-card border border-vast-amber/20 bg-vast-amber/7.5 p-4 text-sm leading-6 text-vast-soft">
                  <span className="font-semibold text-vast-amber">Startup error:</span> {status.error}
                </div>
              )}
            </div>

            <div className="grid w-full gap-2 sm:grid-cols-3" data-testid="avidae-primary-actions">
              <button
                type="button"
                onClick={() => void start()}
                disabled={busy || status?.state === 'starting' || status?.state === 'installing'}
                className="vast-button vast-button--primary vast-button--md h-11 justify-center rounded-card"
              >
                {busy || status?.state === 'starting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Start backend
              </button>
              <button
                type="button"
                onClick={() => void installDependencies()}
                disabled={busy || status?.state === 'installing' || status?.runtimeBundled}
                className="vast-button vast-button--secondary vast-button--md h-11 justify-center rounded-card"
              >
                {status?.state === 'installing' ? <Loader2 className="h-4 w-4 animate-spin" /> : status?.runtimeBundled ? <CheckCircle2 className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                {status?.runtimeBundled ? 'Runtime bundled' : 'Install / repair deps'}
              </button>
              <button
                type="button"
                onClick={() => void stop()}
                disabled={busy || status?.state === 'stopped'}
                className="vast-button vast-button--ghost vast-button--md h-11 justify-center rounded-card border border-white/10 bg-black/25 hover:bg-white/6"
              >
                <Square className="h-4 w-4" />
                Stop
              </button>
            </div>
          </div>


          <div className="mt-6 overflow-hidden rounded-card border border-white/10 bg-black/30">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="text-sm font-semibold text-white">Backend log</div>
              <button type="button" onClick={() => void refresh()} className="vast-button vast-button--quiet vast-button--xs text-xs font-semibold">
                Refresh
              </button>
            </div>
            <pre className="max-h-72 overflow-auto p-4 text-xs leading-6 text-vast-soft">
              {logs.length ? logs.join('\n') : 'Waiting for Video & Audio backend output...'}
            </pre>
          </div>
        </section>
      </div>
    </div>
  )
}

