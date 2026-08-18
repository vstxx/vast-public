import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Download,
  Gift,
  Megaphone,
  ShieldAlert,
  Sparkles,
  X
} from 'lucide-react'
import type { RelayClientSnapshot, RelayPresentation } from '../../../shared/relay-types'
import { ModalShell } from '../ui/ModalShell'
import { RelayRichText } from './RelayRichText'
import './relay-notice.css'

const EMPTY_SNAPSHOT: RelayClientSnapshot = {
  enabled: false,
  environment: 'staging',
  current: null,
  pendingCount: 0
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function presentationTone(presentation: RelayPresentation): string {
  if (presentation.kind === 'update') return presentation.severity
  return presentation.type
}

function presentationEyebrow(presentation: RelayPresentation): string {
  if (presentation.kind === 'update') {
    if (presentation.isBelowMinimumSupported) return 'Unsupported Vast version'
    return presentation.severity === 'critical' ? 'Critical Vast update' : `Vast ${presentation.version}`
  }
  if (presentation.type === 'welcome') return 'Welcome to Vast'
  if (presentation.type === 'seasonal') return 'From Vast'
  if (presentation.type === 'security') return 'Security notice'
  if (presentation.type === 'update_notice') return 'Vast update'
  return 'Vast announcement'
}

function presentationIcon(presentation: RelayPresentation): JSX.Element {
  if (presentation.kind === 'update') {
    return presentation.severity === 'critical'
      ? <ShieldAlert aria-hidden="true" />
      : <Download aria-hidden="true" />
  }
  if (presentation.type === 'welcome') return <Gift aria-hidden="true" />
  if (presentation.type === 'seasonal') return <Sparkles aria-hidden="true" />
  if (presentation.type === 'security') return <ShieldAlert aria-hidden="true" />
  if (presentation.type === 'update_notice') return <Download aria-hidden="true" />
  if (presentation.type === 'announcement') return <Megaphone aria-hidden="true" />
  return <Bell aria-hidden="true" />
}

function actionLabel(presentation: RelayPresentation): string | null {
  if (presentation.kind === 'message') return presentation.actionLabel
  if (presentation.severity === 'critical' || presentation.severity === 'important') return 'Update Vast'
  return 'View update'
}

function useVerifiedMedia(presentation: RelayPresentation | null, reducedMotion: boolean): string | null {
  const media = presentation?.kind === 'message' ? presentation.media : null
  const key = media ? `${presentation?.presentationId}:${media.mime}:${media.sha256}` : ''
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!media || (reducedMotion && media.mime === 'image/gif')) return
    const bytes = Uint8Array.from(media.bytes)
    const nextUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: media.mime }))
    setUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reducedMotion])
  return url
}

export function RelayNoticeOverlay(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<RelayClientSnapshot>(EMPTY_SNAPSHOT)
  const [busy, setBusy] = useState(false)
  const reducedMotion = useReducedMotion()
  const presentation = snapshot.current
  const mediaUrl = useVerifiedMedia(presentation, reducedMotion)

  useEffect(() => {
    let active = true
    void window.vast.relay.state().then((state) => {
      if (active) setSnapshot(state)
    }).catch(() => undefined)
    const unsubscribe = window.vast.relay.onStateChanged((state) => {
      if (active) setSnapshot(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => setBusy(false), [presentation?.presentationId])

  if (!presentation) return null

  const dismiss = (): void => {
    if (busy) return
    setBusy(true)
    void window.vast.relay.dismiss(presentation.presentationId).finally(() => setBusy(false))
  }
  const act = (): void => {
    if (busy) return
    setBusy(true)
    void window.vast.relay.performAction(presentation.presentationId).finally(() => setBusy(false))
  }
  const label = actionLabel(presentation)
  const urgent = presentation.kind === 'update'
    ? presentation.severity === 'critical' || presentation.isBelowMinimumSupported
    : presentation.type === 'security'

  return (
    <ModalShell
      onClose={dismiss}
      width="max-w-[46rem]"
      placement="center"
      ariaLabel={`${presentationEyebrow(presentation)}: ${presentation.title}`}
      className={`relay-notice-shell relay-notice-tone-${presentationTone(presentation)}`}
    >
      <aside
        className="relay-notice-card"
        data-testid="relay-notice"
        data-relay-kind={presentation.kind}
        data-relay-tone={presentationTone(presentation)}
        aria-live={urgent ? 'assertive' : 'polite'}
      >
        {mediaUrl && presentation.kind === 'message' && (
          <div className="relay-notice-media" data-testid="relay-notice-media">
            <img src={mediaUrl} alt="" />
          </div>
        )}
        <div className="relay-notice-content">
          <div className="relay-notice-heading">
            <div className="relay-notice-mark">{presentationIcon(presentation)}</div>
            <div className="relay-notice-copy">
              <h2 data-testid="relay-notice-title">{presentation.title}</h2>
            </div>
            <button
              type="button"
              className="relay-notice-close"
              aria-label="Dismiss Vast message"
              data-testid="relay-notice-dismiss"
              disabled={busy}
              onClick={dismiss}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="relay-notice-scroll">
            <RelayRichText body={presentation.body} />
            {presentation.kind === 'update' && presentation.isBelowMinimumSupported && presentation.minimumSupportedVersion && (
              <p className="relay-notice-support" data-testid="relay-minimum-version">
                This Vast version is below the supported minimum of {presentation.minimumSupportedVersion}.
              </p>
            )}
          </div>
          <div className="relay-notice-footer">
            {presentation.kind === 'update' && (
              <span className="relay-notice-version">Version {presentation.version}</span>
            )}
            {label && (
              <button
                type="button"
                className="relay-notice-action"
                data-testid="relay-notice-action"
                disabled={busy}
                onClick={act}
              >
                {label}
                {presentation.kind === 'message' ? <ArrowUpRight aria-hidden="true" /> : <Download aria-hidden="true" />}
              </button>
            )}
            {!label && urgent && (
              <span className="relay-notice-important"><AlertTriangle aria-hidden="true" /> Important</span>
            )}
          </div>
        </div>
      </aside>
    </ModalShell>
  )
}
