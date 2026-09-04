import { lazy, Suspense, useMemo, type JSX } from 'react'
import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_EXTENSIONS_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_PDF_VIEWER_URL,
  INTERNAL_SESSION_TIMELINE_URL,
  INTERNAL_SITE_DATA_URL
} from '../../../shared/constants'
import { featureGateForInternalUrl, getFeatureStateForGate } from '../../../shared/feature-gates'
import type { BrowserSettings, Tab } from '../../../shared/types'
import { matchesInternalUrl, titleFromUrl } from '../../lib/url'
import { useBrowserStore } from '../../store/browser-store'
import { LocalErrorBoundary } from '../ui/LocalErrorBoundary'
import { FeatureGatePage } from '../internal/FeatureGatePage'
import { NewTabPage } from '../new-tab/NewTabPage'

const AvidaePage = lazy(() => import('../avidae/AvidaePage').then((module) => ({ default: module.AvidaePage })))
const AutomationPage = lazy(() => import('../automation/AutomationPage').then((module) => ({ default: module.AutomationPage })))
const DiagnosticsPage = lazy(() => import('../diagnostics/DiagnosticsPage').then((module) => ({ default: module.DiagnosticsPage })))
const ExtensionsPage = lazy(() => import('../extensions/ExtensionsPage').then((module) => ({ default: module.ExtensionsPage })))
const NetworkPage = lazy(() => import('../network/NetworkPage').then((module) => ({ default: module.NetworkPage })))
const NotesPage = lazy(() => import('../notes/NotesPage').then((module) => ({ default: module.NotesPage })))
const PasswordsPage = lazy(() => import('../passwords/PasswordsPage').then((module) => ({ default: module.PasswordsPage })))
const PdfViewerPage = lazy(() => import('../pdf/PdfViewerPage').then((module) => ({ default: module.PdfViewerPage })))
const SessionTimelinePage = lazy(() => import('../session-timeline/SessionTimelinePage').then((module) => ({ default: module.SessionTimelinePage })))
const SiteDataPage = lazy(() => import('../site-data/SiteDataPage').then((module) => ({ default: module.SiteDataPage })))

function InternalPageFallback(): JSX.Element {
  return (
    <div className="internal-page-shell bg-[linear-gradient(180deg,#08090d,#050507)] p-5">
      <div className="mx-auto max-w-6xl">
        <div className="vast-glass-panel rounded-[30px] p-6">
          <div className="flex items-center gap-3">
            <div className="internal-skeleton h-11 w-11 rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="internal-skeleton h-4 w-40 rounded-full" />
              <div className="internal-skeleton h-3 w-72 rounded-full" />
            </div>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <div className="internal-skeleton h-24 rounded-[24px]" />
            <div className="internal-skeleton h-24 rounded-[24px]" />
            <div className="internal-skeleton h-24 rounded-[24px]" />
          </div>
        </div>
      </div>
    </div>
  )
}

function UnknownInternalPage({ url }: { url: string }): JSX.Element {
  return (
    <div className="internal-page-shell grid place-items-center bg-[linear-gradient(180deg,#08090d,#050507)] p-6">
      <div className="vast-glass-panel max-w-xl rounded-[30px] p-8 text-center">
        <h2 className="text-xl font-semibold text-white">Unknown Vast page</h2>
        <p className="mt-3 text-sm leading-6 text-vast-soft">This version of Vast does not recognize <code>{url}</code>.</p>
      </div>
    </div>
  )
}

export function InternalPageRouter({ tab }: { tab: Tab }): JSX.Element {
  const labs = useBrowserStore((state) => state.settings.labs)
  const featureContextSettings = useMemo(() => ({ labs }) as BrowserSettings, [labs])
  let page: JSX.Element
  if (tab.url === INTERNAL_NEW_TAB_URL) {
    page = <NewTabPage tab={tab} />
  } else {
    const gate = featureGateForInternalUrl(tab.url)
    const featureState = gate ? getFeatureStateForGate(gate, { settings: featureContextSettings }) : undefined
    if (gate && featureState && !featureState.available) {
      page = <FeatureGatePage gate={gate} featureState={featureState} />
    } else {
      page = tab.url === INTERNAL_AVIDAE_URL ? (
        <AvidaePage />
      ) : tab.url === INTERNAL_AUTOMATION_URL ? (
        <AutomationPage />
      ) : tab.url === INTERNAL_PASSWORDS_URL ? (
        <PasswordsPage />
      ) : tab.url === INTERNAL_NOTES_URL ? (
        <NotesPage />
      ) : tab.url === INTERNAL_NETWORK_URL ? (
        <NetworkPage />
      ) : matchesInternalUrl(tab.url, INTERNAL_PDF_VIEWER_URL) ? (
        <PdfViewerPage tab={tab} />
      ) : tab.url === INTERNAL_SITE_DATA_URL ? (
        <SiteDataPage />
      ) : tab.url === INTERNAL_DIAGNOSTICS_URL ? (
        <DiagnosticsPage />
      ) : matchesInternalUrl(tab.url, INTERNAL_EXTENSIONS_URL) ? (
        <ExtensionsPage
          requestedInstallId={new URL(tab.url).searchParams.get('install') ?? undefined}
          requestedExtensionId={new URL(tab.url).searchParams.get('extension') ?? undefined}
        />
      ) : tab.url === INTERNAL_SESSION_TIMELINE_URL ? (
        <SessionTimelinePage />
      ) : (
        <UnknownInternalPage url={tab.url} />
      )
    }
  }

  return (
    <LocalErrorBoundary key={`${tab.id}:${tab.url}`} name={`${titleFromUrl(tab.url)} page`}>
      <Suspense fallback={<InternalPageFallback />}>
        {page}
      </Suspense>
    </LocalErrorBoundary>
  )
}
