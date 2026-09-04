import 'pdfjs-dist/legacy/web/pdf_viewer.css'

import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Info,
  LayoutGrid,
  ListTree,
  Loader2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  RotateCw,
  Search,
  ZoomIn
} from 'lucide-react'
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  PDFDataRangeTransport,
  PDFDateString,
  PermissionFlag,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, FindState, PDFFindController, PDFLinkService, PDFViewer as PdfJsViewer, ScrollMode, SpreadMode } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PdfResourceInfo, Tab } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatBytes } from '../../lib/format'
import { getPdfViewerResourceId, getPdfViewerSource, hostnameFor } from '../../lib/url'
import { useBrowserStore } from '../../store/browser-store'
import { InternalEmptyState } from '../internal/InternalPage'
import { VastSelect } from '../ui/VastSelect'

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString()

type SidebarMode = 'thumbnails' | 'outline' | 'info'

interface PdfOutlineItem {
  title: string
  bold: boolean
  italic: boolean
  color: Uint8ClampedArray
  dest: string | Array<unknown> | null
  url: string | null
  unsafeUrl?: string
  newWindow?: boolean
  count?: number
  items: PdfOutlineItem[]
}

interface PdfDocumentInfo {
  filename?: string
  mimeType?: string
  sizeBytes?: number
  title?: string
  author?: string
  subject?: string
  creator?: string
  producer?: string
  keywords?: string
  createdAt?: string
  modifiedAt?: string
}

interface SearchMatches {
  current: number
  total: number
}

const SCALE_OPTIONS = [
  { value: 'page-width', label: 'Fit width' },
  { value: 'page-fit', label: 'Fit page' },
  { value: 'auto', label: 'Auto' },
  { value: '0.75', label: '75%' },
  { value: '1', label: '100%' },
  { value: '1.25', label: '125%' },
  { value: '1.5', label: '150%' },
  { value: '2', label: '200%' }
]

const SCROLL_MODE_OPTIONS = [
  { value: ScrollMode.VERTICAL, label: 'Vertical' },
  { value: ScrollMode.PAGE, label: 'Single page' },
  { value: ScrollMode.HORIZONTAL, label: 'Horizontal' },
  { value: ScrollMode.WRAPPED, label: 'Wrapped' }
]

const SPREAD_MODE_OPTIONS = [
  { value: SpreadMode.NONE, label: 'No spreads' },
  { value: SpreadMode.ODD, label: 'Odd spreads' },
  { value: SpreadMode.EVEN, label: 'Even spreads' }
]

function PdfSelect<T extends string | number>({
  label,
  value,
  options,
  onChange,
  compact
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  compact?: boolean
}): JSX.Element {
  return (
    <VastSelect
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={label}
      className={`pdf-select ${compact ? 'pdf-select-compact' : ''}`}
      align="end"
    />
  )
}

function stripHash(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return rawUrl.split('#', 1)[0] ?? rawUrl
  }
}

function sourceHash(rawUrl: string): string {
  try {
    return new URL(rawUrl).hash.replace(/^#/, '')
  } catch {
    return ''
  }
}

function fallbackPdfFilename(sourceUrl: string, preferred?: string): string {
  const chosen = preferred?.trim()
  if (chosen) return chosen.toLowerCase().endsWith('.pdf') ? chosen : `${chosen}.pdf`
  try {
    const candidate = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() ?? '').trim()
    if (candidate) return candidate.toLowerCase().endsWith('.pdf') ? candidate : `${candidate}.pdf`
  } catch {
    // Fall through to default name.
  }
  return 'document.pdf'
}

function normalizeTextValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function formatPdfDate(value: unknown): string | undefined {
  const raw = normalizeTextValue(value)
  if (!raw) return undefined
  const parsed = PDFDateString.toDateObject(raw)
  return parsed ? parsed.toLocaleString() : raw
}

function outlineTextStyle(item: PdfOutlineItem, level: number): CSSProperties {
  return {
    paddingLeft: `${Math.min(20, level) * 14}px`,
    color: item.color?.length >= 3 ? `rgb(${item.color[0]} ${item.color[1]} ${item.color[2]})` : undefined,
    fontWeight: item.bold ? 700 : 500,
    fontStyle: item.italic ? 'italic' : 'normal'
  }
}

function canPrintDocument(permissions: number[] | null): boolean {
  if (!permissions) return true
  return permissions.includes(PermissionFlag.PRINT) || permissions.includes(PermissionFlag.PRINT_HIGH_QUALITY)
}

function canCopyDocument(permissions: number[] | null): boolean {
  if (!permissions) return true
  return permissions.includes(PermissionFlag.COPY)
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
}

class VastPdfRangeTransport extends PDFDataRangeTransport {
  private stopped = false

  constructor(
    length: number,
    private readonly resourceId: string,
    private readonly onFailure: (error: Error) => void
  ) {
    super(length, null, true)
  }

  requestDataRange(begin: number, end: number): void {
    if (this.stopped) return
    void window.vast.pdf.readRange(this.resourceId, begin, end).then((result) => {
      if (this.stopped) return
      if (!result.ok || !result.data) throw new Error(result.error || 'Vast could not read the requested PDF range.')
      const data = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data)
      this.onDataRange(begin, data)
    }).catch((error: unknown) => {
      if (!this.stopped) this.onFailure(error instanceof Error ? error : new Error('PDF range read failed.'))
    })
  }

  abort(): void {
    this.stopped = true
  }
}

function ToolbarButton({
  onClick,
  title,
  disabled,
  active,
  wide,
  children
}: {
  onClick: () => void
  title: string
  disabled?: boolean
  active?: boolean
  wide?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={[
        wide ? 'flex h-8 items-center gap-2 rounded-xl px-3' : 'grid h-8 w-8 place-items-center rounded-xl',
        'border text-sm transition',
        'shrink-0',
        active
          ? 'border-[rgba(255,175,110,0.38)] bg-[rgba(255,154,82,0.18)] text-white shadow-[0_10px_24px_rgba(255,146,71,0.12)]'
          : 'border-white/[0.08] bg-white/[0.045] text-vast-soft hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white',
        disabled ? 'cursor-not-allowed opacity-40' : ''
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function SidebarTabButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-2xl border px-3 text-sm font-medium transition ${
        active
          ? 'border-[rgba(255,175,110,0.32)] bg-[rgba(255,154,82,0.16)] text-white'
          : 'border-transparent bg-white/[0.04] text-vast-soft hover:bg-white/[0.08] hover:text-white'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function PdfOutlineTree({
  items,
  level = 0,
  onSelect
}: {
  items: PdfOutlineItem[]
  level?: number
  onSelect: (item: PdfOutlineItem) => void
}): JSX.Element {
  return (
    <div className="space-y-1">
      {items.map((item, index) => (
        <div key={`${level}-${index}-${item.title}-${item.url ?? String(item.dest ?? '')}`}>
          <button
            type="button"
            onClick={() => onSelect(item)}
            className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition hover:bg-white/[0.06]"
            style={outlineTextStyle(item, level)}
          >
            <span className="truncate">{item.title || 'Untitled section'}</span>
            {typeof item.count === 'number' && <span className="ml-3 shrink-0 text-[11px] text-vast-soft">{Math.abs(item.count)}</span>}
          </button>
          {item.items.length > 0 && <PdfOutlineTree items={item.items} level={level + 1} onSelect={onSelect} />}
        </div>
      ))}
    </div>
  )
}

function PdfThumbnailItem({
  pdfDocument,
  pageNumber,
  label,
  active,
  onClick
}: {
  pdfDocument: PDFDocumentProxy
  pageNumber: number
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rendered, setRendered] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null
    let pageToCleanup: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
    setRendered(false)
    setError(false)

    void pdfDocument
      .getPage(pageNumber)
      .then((page) => {
        pageToCleanup = page
        if (cancelled || !canvasRef.current) return
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(1, 132 / baseViewport.width, 154 / baseViewport.height)
        const viewport = page.getViewport({ scale })
        const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        const context = canvasRef.current.getContext('2d', { alpha: false })
        if (!context) return

        canvasRef.current.width = Math.ceil(viewport.width * devicePixelRatio)
        canvasRef.current.height = Math.ceil(viewport.height * devicePixelRatio)
        canvasRef.current.style.width = `${Math.ceil(viewport.width)}px`
        canvasRef.current.style.height = `${Math.ceil(viewport.height)}px`

        context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
        context.fillStyle = '#101217'
        context.fillRect(0, 0, viewport.width, viewport.height)

        renderTask = page.render({
          canvas: canvasRef.current,
          canvasContext: context,
          viewport
        }) as { cancel: () => void; promise: Promise<void> }

        return renderTask.promise.then(() => {
          if (!cancelled) setRendered(true)
        })
      })
      .catch((renderError: unknown) => {
        if (cancelled || (renderError as { name?: string })?.name === 'RenderingCancelledException') return
        console.warn(`[vast:pdf] Thumbnail ${pageNumber} render failed without exposing document data.`)
        setError(true)
      })
      .finally(() => pageToCleanup?.cleanup())

    return () => {
      cancelled = true
      renderTask?.cancel()
      if (canvasRef.current) {
        canvasRef.current.width = 0
        canvasRef.current.height = 0
      }
      pageToCleanup?.cleanup()
    }
  }, [attempt, pdfDocument, pageNumber])

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={() => error && setAttempt((value) => value + 1)}
      className={`group h-[232px] w-full rounded-[22px] border p-3 text-left transition ${
        active
          ? 'border-[rgba(255,175,110,0.34)] bg-[rgba(255,154,82,0.12)] shadow-[0_10px_26px_rgba(255,140,64,0.08)]'
          : 'border-white/[0.08] bg-white/[0.035] hover:border-white/[0.14] hover:bg-white/[0.06]'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.18em] text-vast-soft">
        <span>Page</span>
        <span>{label}</span>
      </div>
      <div className="grid h-[174px] place-items-center rounded-[18px] bg-[#0d1015] p-2 ring-1 ring-white/[0.06]">
        <canvas ref={canvasRef} className={`max-w-full rounded-[10px] shadow-[0_18px_36px_rgba(0,0,0,0.25)] transition ${rendered ? 'opacity-100' : 'opacity-0'}`} />
        {!rendered && !error && <div className="h-[154px] w-[120px] rounded-[10px] bg-white/[0.05]" />}
        {error && <div className="px-3 text-center text-xs leading-5 text-vast-soft">Preview failed. Double-click to retry.</div>}
      </div>
    </button>
  )
}

const THUMBNAIL_ROW_HEIGHT = 244

function PdfThumbnailList({
  pdfDocument,
  pagesCount,
  pageLabels,
  currentPage,
  onSelect
}: {
  pdfDocument: PDFDocumentProxy
  pagesCount: number
  pageLabels: string[] | null
  currentPage: number
  onSelect: (page: number) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 640 })

  useEffect(() => {
    const target = scrollRef.current
    if (!target) return
    const update = (): void => setViewport({ scrollTop: target.scrollTop, height: target.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(target)
    target.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      target.removeEventListener('scroll', update)
    }
  }, [])

  useEffect(() => {
    const target = scrollRef.current
    if (!target) return
    const top = (currentPage - 1) * THUMBNAIL_ROW_HEIGHT
    const bottom = top + THUMBNAIL_ROW_HEIGHT
    if (top < target.scrollTop || bottom > target.scrollTop + target.clientHeight) {
      target.scrollTo({ top: Math.max(0, top - target.clientHeight / 2 + THUMBNAIL_ROW_HEIGHT / 2), behavior: 'smooth' })
    }
  }, [currentPage])

  const start = Math.max(0, Math.floor(viewport.scrollTop / THUMBNAIL_ROW_HEIGHT) - 4)
  const end = Math.min(pagesCount, Math.ceil((viewport.scrollTop + viewport.height) / THUMBNAIL_ROW_HEIGHT) + 4)
  const visiblePages = Array.from({ length: end - start }, (_item, index) => start + index + 1)

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto pr-1">
      <div className="relative" style={{ height: `${pagesCount * THUMBNAIL_ROW_HEIGHT}px` }}>
        {visiblePages.map((pageNumber) => (
          <div key={`thumb-${pageNumber}`} className="absolute inset-x-0" style={{ top: `${(pageNumber - 1) * THUMBNAIL_ROW_HEIGHT}px` }}>
            <PdfThumbnailItem
              pdfDocument={pdfDocument}
              pageNumber={pageNumber}
              label={pageLabels?.[pageNumber - 1] ?? String(pageNumber)}
              active={pageNumber === currentPage}
              onClick={() => onSelect(pageNumber)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export function PdfViewerPage({ tab }: { tab: Tab }): JSX.Element {
  const runtime = useBrowserRuntime()
  const updateTab = useBrowserStore((state) => state.updateTab)
  const sourceUrl = getPdfViewerSource(tab.url)
  const resourceId = getPdfViewerResourceId(tab.url)
  const sourceHost = sourceUrl ? hostnameFor(sourceUrl) : ''
  const localSource = sourceUrl?.startsWith('file:') ?? false

  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const pageInputRef = useRef<HTMLInputElement | null>(null)
  const eventBusRef = useRef<EventBus | null>(null)
  const linkServiceRef = useRef<PDFLinkService | null>(null)
  const pdfViewerRef = useRef<PdfJsViewer | null>(null)
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const rangeTransportRef = useRef<VastPdfRangeTransport | null>(null)

  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [documentInfo, setDocumentInfo] = useState<PdfDocumentInfo>({})
  const [pagesCount, setPagesCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [currentScale, setCurrentScale] = useState(1)
  const [scaleValue, setScaleValue] = useState('page-width')
  const [rotation, setRotation] = useState(0)
  const [scrollMode, setScrollMode] = useState<number>(ScrollMode.VERTICAL)
  const [spreadMode, setSpreadMode] = useState<number>(SpreadMode.NONE)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('thumbnails')
  const [outline, setOutline] = useState<PdfOutlineItem[]>([])
  const [pageLabels, setPageLabels] = useState<string[] | null>(null)
  const [permissions, setPermissions] = useState<number[] | null>(null)
  const [pageDraft, setPageDraft] = useState('1')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<SearchMatches>({ current: 0, total: 0 })
  const [searchStatus, setSearchStatus] = useState<'idle' | 'pending' | 'found' | 'wrapped' | 'not-found'>('idle')
  const [passwordValue, setPasswordValue] = useState('')
  const [printing, setPrinting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<{ received: number; total: number } | null>(null)
  const [passwordRequest, setPasswordRequest] = useState<{
    reason: 'required' | 'incorrect'
    submit: (password: string) => void
  } | null>(null)

  const printAllowed = canPrintDocument(permissions)
  const copyAllowed = canCopyDocument(permissions)

  const requestPdfPrint = async (): Promise<void> => {
    if (!resourceId || loadState !== 'ready' || !printAllowed || printing) return
    setPrinting(true)
    try {
      const result = await window.vast.pdf.print(resourceId)
      if (!result.ok) throw new Error(result.error || 'PDF print failed.')
    } catch (error: unknown) {
      console.error('[vast:pdf:print] failed:', error)
    } finally {
      setPrinting(false)
    }
  }

  useEffect(() => {
    setPageDraft(pageLabels?.[currentPage - 1] ?? String(currentPage))
  }, [currentPage, pageLabels])

  useEffect(() => {
    const viewer = pdfViewerRef.current
    if (!viewer) return
    viewer.scrollMode = scrollMode
  }, [scrollMode])

  useEffect(() => {
    const viewer = pdfViewerRef.current
    if (!viewer) return
    viewer.spreadMode = spreadMode
  }, [spreadMode])

  useEffect(() => {
    const eventBus = eventBusRef.current
    if (!eventBus) return

    if (!searchQuery.trim()) {
      setSearchMatches({ current: 0, total: 0 })
      setSearchStatus('idle')
      eventBus.dispatch('findbarclose', { source: 'vast-pdf-viewer' })
      return
    }

    const timeout = window.setTimeout(() => {
      eventBus.dispatch('find', {
        source: 'vast-pdf-viewer',
        type: '',
        query: searchQuery,
        phraseSearch: true,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: false,
        matchDiacritics: false
      })
    }, 160)

    return () => window.clearTimeout(timeout)
  }, [searchQuery])

  useEffect(() => {
    if (!sourceUrl || !resourceId || !containerRef.current || !viewerRef.current) return

    const container = containerRef.current
    const viewerNode = viewerRef.current
    let disposed = false
    let unsubscribeDownload: (() => void) | undefined

    setLoadState('loading')
    setLoadError(null)
    setDocumentInfo({})
    setPagesCount(0)
    setCurrentPage(1)
    setCurrentScale(1)
    setScaleValue('page-width')
    setRotation(0)
    setOutline([])
    setPageLabels(null)
    setPermissions(null)
    setSearchMatches({ current: 0, total: 0 })
    setSearchStatus('idle')
    setPasswordValue('')
    setPasswordRequest(null)
    setDownloadProgress(null)

    updateTab(tab.id, {
      displayUrl: sourceUrl,
      status: 'loading',
      progress: 0.2,
      error: undefined
    })

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ linkService, eventBus })
    const pdfViewer = new PdfJsViewer({
      container,
      viewer: viewerNode,
      eventBus,
      linkService,
      findController,
      removePageBorders: true,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      enablePrintAutoRotate: true,
      enableOptimizedPartialRendering: true,
      supportsPinchToZoom: true,
      enableAutoLinking: true,
      minDurationToUpdateCanvas: 140
    })

    linkService.setViewer(pdfViewer)
    findController.onIsPageVisible = (pageNumber: number): boolean => pageNumber === pdfViewer.currentPageNumber

    eventBusRef.current = eventBus
    linkServiceRef.current = linkService
    pdfViewerRef.current = pdfViewer
    container.scrollTop = 0
    container.scrollLeft = 0
    viewerNode.textContent = ''

    const onPageChanging = (event: { pageNumber?: number }): void => {
      if (disposed) return
      setCurrentPage(Math.max(1, event.pageNumber ?? pdfViewer.currentPageNumber))
    }

    const onScaleChanging = (event: { scale?: number; presetValue?: string }): void => {
      if (disposed) return
      setCurrentScale(event.scale ?? pdfViewer.currentScale)
      setScaleValue(typeof event.presetValue === 'string' ? event.presetValue : String(pdfViewer.currentScaleValue))
    }

    const onRotationChanging = (event: { pagesRotation?: number }): void => {
      if (disposed) return
      setRotation(event.pagesRotation ?? pdfViewer.pagesRotation)
    }

    const onPagesInit = (): void => {
      if (disposed) return
      pdfViewer.currentScaleValue = sourceHash(sourceUrl) ? 'auto' : 'page-width'
      pdfViewer.scrollMode = scrollMode
      pdfViewer.spreadMode = spreadMode
      const initialHash = sourceHash(sourceUrl)
      if (initialHash) linkService.setHash(initialHash)
      setCurrentScale(pdfViewer.currentScale)
      setScaleValue(String(pdfViewer.currentScaleValue))
    }

    let firstPageRendered = false
    const onPageRendered = (): void => {
      if (disposed || firstPageRendered) return
      firstPageRendered = true
      setLoadState('ready')
      updateTab(tab.id, { status: 'idle', progress: 0, error: undefined })
    }

    const onFindMatchesCount = (event: { matchesCount?: SearchMatches }): void => {
      if (disposed) return
      setSearchMatches(event.matchesCount ?? { current: 0, total: 0 })
    }

    const onFindControlState = (event: { state?: number }): void => {
      if (disposed) return
      switch (event.state) {
        case FindState.PENDING:
          setSearchStatus('pending')
          break
        case FindState.NOT_FOUND:
          setSearchStatus('not-found')
          break
        case FindState.WRAPPED:
          setSearchStatus('wrapped')
          break
        case FindState.FOUND:
          setSearchStatus('found')
          break
        default:
          setSearchStatus('idle')
      }
    }

    const onViewerClick = (event: MouseEvent): void => {
      const link = (event.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null
      if (!link?.href) return
      if (link.getAttribute('href')?.startsWith('#')) return
      try {
        const resolved = new URL(link.href, stripHash(sourceUrl)).toString()
        if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
          event.preventDefault()
          runtime.openUrlInNewTab(resolved)
        }
      } catch {
        // Ignore malformed annotation links.
      }
    }

    eventBus.on('pagechanging', onPageChanging)
    eventBus.on('scalechanging', onScaleChanging)
    eventBus.on('rotationchanging', onRotationChanging)
    eventBus.on('pagesinit', onPagesInit)
    eventBus.on('pagerendered', onPageRendered)
    eventBus.on('updatefindmatchescount', onFindMatchesCount)
    eventBus.on('updatefindcontrolstate', onFindControlState)
    container.addEventListener('click', onViewerClick)

    void (async () => {
      try {
        const result = await window.vast.pdf.info(resourceId)
        if (!result.ok || !result.resource) {
          throw new Error(result.error || 'The captured PDF resource is unavailable.')
        }
        if (disposed) return

        let resource: PdfResourceInfo = result.resource
        if (resource.state === 'failed') throw new Error(resource.error || 'The original PDF request failed.')
        if (resource.state === 'downloading') {
          setDownloadProgress({ received: resource.receivedBytes, total: resource.totalBytes })
          resource = await new Promise<PdfResourceInfo>((resolve, reject) => {
            let settled = false
            const finish = (outcome: { ok: boolean; resource?: PdfResourceInfo; error?: string }): void => {
              if (settled || disposed) return
              if (!outcome.ok || !outcome.resource) {
                settled = true
                unsubscribeDownload?.()
                reject(new Error(outcome.error || 'The captured PDF resource became unavailable.'))
                return
              }
              if (outcome.resource.state === 'failed') {
                settled = true
                unsubscribeDownload?.()
                reject(new Error(outcome.resource.error || 'The original PDF request failed.'))
                return
              }
              setDownloadProgress({
                received: outcome.resource.receivedBytes,
                total: outcome.resource.totalBytes
              })
              if (outcome.resource.state === 'ready') {
                settled = true
                unsubscribeDownload?.()
                resolve(outcome.resource)
              }
            }
            unsubscribeDownload = window.vast.pdf.onCapture((capture) => {
              if (capture.id !== resourceId) return
              setDownloadProgress({ received: capture.receivedBytes, total: capture.totalBytes })
              updateTab(tab.id, {
                status: capture.state === 'failed' ? 'error' : 'loading',
                progress: capture.totalBytes > 0 ? Math.min(0.7, capture.receivedBytes / capture.totalBytes * 0.7) : 0.18
              })
              if (capture.state === 'ready' || capture.state === 'failed') {
                void window.vast.pdf.info(resourceId).then(finish).catch((error: unknown) => finish({
                  ok: false,
                  error: error instanceof Error ? error.message : 'Could not refresh PDF state.'
                }))
              }
            })
            // Close the event-subscription race if the download completed
            // between the first info call and listener registration.
            void window.vast.pdf.info(resourceId).then(finish).catch((error: unknown) => finish({
              ok: false,
              error: error instanceof Error ? error.message : 'Could not refresh PDF state.'
            }))
          })
        }
        setDownloadProgress(null)
        const filename = fallbackPdfFilename(sourceUrl, resource.filename)
        setDocumentInfo((current) => ({
          ...current,
          filename,
          mimeType: resource.mimeType || 'application/pdf',
          sizeBytes: resource.sizeBytes
        }))

        const rangeTransport = new VastPdfRangeTransport(resource.sizeBytes, resourceId, (rangeError) => {
          if (disposed) return
          setLoadState('error')
          setLoadError(rangeError.message)
          void loadingTaskRef.current?.destroy().catch(() => undefined)
        })
        rangeTransportRef.current = rangeTransport
        const loadingTask = getDocument({
          range: rangeTransport,
          rangeChunkSize: 256 * 1024,
          disableStream: true,
          disableAutoFetch: true,
          enableXfa: true,
          useWorkerFetch: false
        })
        loadingTaskRef.current = loadingTask

        loadingTask.onPassword = (submitPassword: (password: string) => void, reason: number): void => {
          if (disposed) return
          setPasswordRequest({
            reason: reason === PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'required',
            submit: (password: string) => {
              submitPassword(password)
              setPasswordValue('')
              setPasswordRequest(null)
            }
          })
        }

        const pdfDocument = await loadingTask.promise
        if (disposed) {
          await loadingTask.destroy().catch(() => undefined)
          return
        }

        pdfDocumentRef.current = pdfDocument
        setPagesCount(pdfDocument.numPages)

        const [outlineItems, labels, pdfPermissions, metadata] = await Promise.all([
          pdfDocument.getOutline().catch(() => []),
          pdfDocument.getPageLabels().catch(() => null),
          pdfDocument.getPermissions().catch(() => null),
          pdfDocument.getMetadata().catch(() => null)
        ])

        if (disposed) return

        const metadataInfo = (metadata?.info ?? {}) as Record<string, unknown>
        const metadataTitle = normalizeTextValue(metadataInfo.Title)
        const derivedTitle = metadataTitle || filename

        setOutline((outlineItems as PdfOutlineItem[] | null) ?? [])
        setPageLabels(labels)
        setPermissions(pdfPermissions)
        setDocumentInfo((current) => ({
          ...current,
          filename,
          mimeType: resource.mimeType || 'application/pdf',
          sizeBytes: resource.sizeBytes,
          title: metadataTitle,
          author: normalizeTextValue(metadataInfo.Author),
          subject: normalizeTextValue(metadataInfo.Subject),
          creator: normalizeTextValue(metadataInfo.Creator),
          producer: normalizeTextValue(metadataInfo.Producer),
          keywords: normalizeTextValue(metadataInfo.Keywords),
          createdAt: formatPdfDate(metadataInfo.CreationDate),
          modifiedAt: formatPdfDate(metadataInfo.ModDate)
        }))

        updateTab(tab.id, {
          title: derivedTitle,
          displayUrl: sourceUrl,
          status: 'loading',
          progress: 0.72,
          error: undefined
        })

        linkService.setDocument(pdfDocument)
        pdfViewer.setDocument(pdfDocument)
      } catch (error) {
        if (disposed) return
        const message = error instanceof Error ? error.message : String(error)
        setLoadState('error')
        setLoadError(message)
        updateTab(tab.id, {
          status: 'error',
          progress: 0,
          error: {
            code: 0,
            description: message,
            validatedUrl: sourceUrl
          }
        })
      }
    })()

    return () => {
      disposed = true
      unsubscribeDownload?.()
      container.removeEventListener('click', onViewerClick)
      eventBus.off('pagechanging', onPageChanging)
      eventBus.off('scalechanging', onScaleChanging)
      eventBus.off('rotationchanging', onRotationChanging)
      eventBus.off('pagesinit', onPagesInit)
      eventBus.off('pagerendered', onPageRendered)
      eventBus.off('updatefindmatchescount', onFindMatchesCount)
      eventBus.off('updatefindcontrolstate', onFindControlState)
      viewerNode.textContent = ''
      eventBusRef.current = null
      linkServiceRef.current = null
      pdfViewerRef.current = null
      rangeTransportRef.current?.abort()
      rangeTransportRef.current = null
      void loadingTaskRef.current?.destroy().catch(() => undefined)
      loadingTaskRef.current = null
      pdfDocumentRef.current = null
    }
  }, [resourceId, runtime, sourceUrl, tab.id, updateTab])

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<{ type?: string }>).detail
      const viewer = pdfViewerRef.current
      if (!viewer || !detail?.type) return

      if (detail.type === 'zoom-in') viewer.increaseScale({ steps: 1 })
      else if (detail.type === 'zoom-out') viewer.decreaseScale({ steps: 1 })
      else if (detail.type === 'reset-zoom') viewer.currentScaleValue = 'page-width'
      else if (detail.type === 'print') {
        void requestPdfPrint()
      } else if (detail.type === 'focus-search') {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const viewer = pdfViewerRef.current
      if (!viewer) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        void requestPdfPrint()
        return
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        viewer.increaseScale({ steps: 1 })
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '-') {
        event.preventDefault()
        viewer.decreaseScale({ steps: 1 })
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault()
        viewer.currentScaleValue = 'page-width'
        return
      }
      if (isTypingTarget(event.target)) return

      if (event.key === 'PageDown' || event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault()
        viewer.nextPage()
      } else if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        viewer.previousPage()
      } else if (event.key === 'Home') {
        event.preventDefault()
        viewer.currentPageNumber = 1
      } else if (event.key === 'End') {
        event.preventDefault()
        viewer.currentPageNumber = pagesCount
      }
    }

    window.addEventListener('vast-pdf-command', onCommand as EventListener)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('vast-pdf-command', onCommand as EventListener)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [documentInfo.filename, loadState, pagesCount, printAllowed, printing, resourceId, sourceUrl, tab.url])

  const scaleSelectValue = SCALE_OPTIONS.some((option) => option.value === scaleValue) ? scaleValue : 'custom'
  const scaleOptions = useMemo(
    () => (scaleSelectValue === 'custom' ? [...SCALE_OPTIONS, { value: 'custom', label: `${Math.round(currentScale * 100)}%` }] : SCALE_OPTIONS),
    [currentScale, scaleSelectValue]
  )
  const visiblePageLabel = pageLabels?.[currentPage - 1] ?? String(currentPage)
  const documentName = documentInfo.title || documentInfo.filename || tab.title || 'PDF document'
  const infoRows = useMemo(
    () =>
      [
        ['Filename', documentInfo.filename],
        ['Source', sourceHost || sourceUrl],
        ['Pages', pagesCount ? String(pagesCount) : undefined],
        ['Size', documentInfo.sizeBytes ? formatBytes(documentInfo.sizeBytes) : undefined],
        ['Author', documentInfo.author],
        ['Subject', documentInfo.subject],
        ['Creator', documentInfo.creator],
        ['Producer', documentInfo.producer],
        ['Keywords', documentInfo.keywords],
        ['Created', documentInfo.createdAt],
        ['Modified', documentInfo.modifiedAt],
        ['Permissions', permissions ? `${printAllowed ? 'Print' : 'No print'} • ${copyAllowed ? 'No copy restrictions' : 'Copy restricted'}` : 'Standard']
      ].filter((entry) => entry[1]),
    [copyAllowed, documentInfo, pagesCount, permissions, printAllowed, sourceHost, sourceUrl]
  )

  const goToSearchMatch = (findPrevious: boolean): void => {
    const eventBus = eventBusRef.current
    if (!eventBus || !searchQuery.trim()) return
    eventBus.dispatch('find', {
      source: 'vast-pdf-viewer',
      type: 'again',
      query: searchQuery,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false
    })
  }

  const handleDownload = async (): Promise<void> => {
    if (!resourceId || !sourceUrl || loadState !== 'ready' || saving) return
    setSaving(true)
    try {
      const result = await window.vast.pdf.save(resourceId, fallbackPdfFilename(sourceUrl, documentInfo.filename))
      if (!result.ok) throw new Error(result.error || 'PDF save failed.')
    } catch (error: unknown) {
      console.error('[vast:pdf:save] failed without exposing document data:', error instanceof Error ? error.message : 'unknown error')
    } finally {
      setSaving(false)
    }
  }

  const handleCopyLink = (): void => {
    if (!sourceUrl || localSource) return
    void navigator.clipboard.writeText(sourceUrl)
  }

  const handleOpenOriginal = (): void => {
    if (!sourceUrl || !resourceId) return
    if (localSource) {
      void window.vast.pdf.openExternal(resourceId)
      return
    }
    runtime.openUrlInNewTab(sourceUrl)
  }

  const handleRotate = (): void => {
    const viewer = pdfViewerRef.current
    if (!viewer) return
    viewer.pagesRotation = (viewer.pagesRotation + 90) % 360
  }

  const handlePageSubmit = (): void => {
    const viewer = pdfViewerRef.current
    if (!viewer) return
    const draft = pageDraft.trim()
    if (!draft) return
    const numeric = Number(draft)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= pagesCount) {
      viewer.currentPageNumber = numeric
      return
    }
    try {
      viewer.currentPageLabel = draft
    } catch {
      setPageDraft(visiblePageLabel)
    }
  }

  const handleOutlineSelect = (item: PdfOutlineItem): void => {
    if (item.url) {
      runtime.openUrlInNewTab(item.url)
      return
    }
    if (item.dest) {
      void linkServiceRef.current?.goToDestination(item.dest)
    }
  }

  if (!sourceUrl || !resourceId) {
    return (
      <div className="grid h-full place-items-center bg-[radial-gradient(circle_at_top,rgba(255,162,94,0.12),transparent_26%),linear-gradient(180deg,#09090d,#050507)] p-6">
        <InternalEmptyState
          icon={FileText}
          title="Missing PDF source"
          description="This internal viewer route does not contain a valid, window-scoped PDF resource."
        />
      </div>
    )
  }

  return (
    <div className="pdf-viewer-shell flex h-full min-h-0 flex-col gap-2 bg-[radial-gradient(circle_at_top,rgba(255,162,94,0.12),transparent_26%),linear-gradient(180deg,#09090d,#050507)] p-2 md:p-3">
      <section className="vast-glass-panel relative z-40 rounded-[22px] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full border border-[rgba(255,175,110,0.22)] bg-[rgba(255,154,82,0.12)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#ffd4b4]">Built-in PDF</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white" title={documentName}>{documentName}</span>
          <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-vast-soft sm:flex">
            {sourceHost && <span>{sourceHost}</span>}
            {pagesCount > 0 && <><span className="opacity-30">·</span><span>{pagesCount}p</span></>}
            {documentInfo.sizeBytes && <><span className="opacity-30">·</span><span>{formatBytes(documentInfo.sizeBytes)}</span></>}
          </span>
          <div className="ml-1 flex shrink-0 items-center gap-1">
            <ToolbarButton title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setSidebarOpen((open) => !open)} active={sidebarOpen}>
              {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
            </ToolbarButton>
            {!localSource && <ToolbarButton title="Copy source link" onClick={handleCopyLink}>
              <Copy className="h-3.5 w-3.5" />
            </ToolbarButton>}
            <ToolbarButton title={localSource ? 'Open in system PDF viewer' : 'Open original URL'} onClick={handleOpenOriginal}>
              <ExternalLink className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton title="Download PDF" onClick={() => void handleDownload()} disabled={saving || loadState !== 'ready'}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </ToolbarButton>
            <ToolbarButton
              title={printAllowed ? 'Open print preview' : 'Printing disabled by document permissions'}
              onClick={() => void requestPdfPrint()}
              disabled={loadState !== 'ready' || !printAllowed || printing}
              wide
            >
              {printing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
              <span className="hidden text-xs font-semibold sm:inline">{printing ? 'Preparing' : 'Print'}</span>
            </ToolbarButton>
          </div>
        </div>

        <div className="mt-2 grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] xl:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <div className="pdf-control-group">
              <ToolbarButton title="Previous page" onClick={() => pdfViewerRef.current?.previousPage()} disabled={currentPage <= 1}>
                <ChevronLeft className="h-4 w-4" />
              </ToolbarButton>
              <div className="flex items-center gap-1.5 rounded-xl bg-white/[0.04] px-2.5 py-1">
                <input
                  ref={pageInputRef}
                  value={pageDraft}
                  onChange={(event) => setPageDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handlePageSubmit()
                    }
                  }}
                  className="w-16 bg-transparent text-center text-sm font-semibold text-white outline-none"
                />
                <span className="text-xs text-vast-soft">/ {pageLabels?.length ?? pagesCount}</span>
              </div>
              <ToolbarButton title="Next page" onClick={() => pdfViewerRef.current?.nextPage()} disabled={currentPage >= pagesCount}>
                <ChevronRight className="h-4 w-4" />
              </ToolbarButton>
            </div>

            <div className="pdf-control-group">
              <ToolbarButton title="Zoom out" onClick={() => pdfViewerRef.current?.decreaseScale({ steps: 1 })}>
                <Minus className="h-4 w-4" />
              </ToolbarButton>
              <div className="rounded-xl bg-white/[0.04] px-2.5 py-1 text-sm font-semibold text-white">{Math.round(currentScale * 100)}%</div>
              <ToolbarButton title="Zoom in" onClick={() => pdfViewerRef.current?.increaseScale({ steps: 1 })}>
                <ZoomIn className="h-4 w-4" />
              </ToolbarButton>
              <PdfSelect
                label="Zoom"
                value={scaleSelectValue}
                options={scaleOptions}
                onChange={(value) => {
                  const viewer = pdfViewerRef.current
                  if (!viewer) return
                  if (value !== 'custom') viewer.currentScaleValue = value
                }}
                compact
              />
            </div>

            <div className="pdf-control-group">
              <PdfSelect
                label="Scroll mode"
                value={scrollMode}
                options={SCROLL_MODE_OPTIONS}
                onChange={setScrollMode}
              />
              <PdfSelect
                label="Spread mode"
                value={spreadMode}
                options={SPREAD_MODE_OPTIONS}
                onChange={setSpreadMode}
              />
              <ToolbarButton title="Rotate pages" onClick={handleRotate}>
                <RotateCw className="h-4 w-4" />
              </ToolbarButton>
            </div>
          </div>

          <div className="pdf-control-group min-w-0 xl:w-full">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-vast-soft">
              <Search className="h-4 w-4" />
            </div>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  goToSearchMatch(event.shiftKey)
                }
              }}
              placeholder="Search inside this PDF"
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-vast-soft"
            />
            <div className="rounded-xl bg-white/[0.04] px-2.5 py-1 text-xs text-vast-soft">
              {searchQuery.trim() ? `${searchMatches.current}/${searchMatches.total}` : 'Find'}
            </div>
            <ToolbarButton title="Previous match" onClick={() => goToSearchMatch(true)} disabled={!searchQuery.trim()}>
              <ChevronLeft className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="Next match" onClick={() => goToSearchMatch(false)} disabled={!searchQuery.trim()}>
              <ChevronRight className="h-4 w-4" />
            </ToolbarButton>
          </div>
        </div>
      </section>

      <div className="relative z-10 flex min-h-0 flex-1 gap-4 overflow-hidden">
        {sidebarOpen && (
          <aside className="vast-glass-panel hidden w-[320px] shrink-0 flex-col overflow-hidden rounded-[30px] p-3 lg:flex">
            <div className="mb-3 flex gap-2">
              <SidebarTabButton active={sidebarMode === 'thumbnails'} icon={<LayoutGrid className="h-4 w-4" />} label="Thumbnails" onClick={() => setSidebarMode('thumbnails')} />
              <SidebarTabButton active={sidebarMode === 'outline'} icon={<ListTree className="h-4 w-4" />} label="Outline" onClick={() => setSidebarMode('outline')} />
              <SidebarTabButton active={sidebarMode === 'info'} icon={<Info className="h-4 w-4" />} label="Info" onClick={() => setSidebarMode('info')} />
            </div>

            <div className={`min-h-0 flex-1 ${sidebarMode === 'thumbnails' ? 'overflow-hidden' : 'overflow-y-auto pr-1'}`}>
              {sidebarMode === 'thumbnails' && pdfDocumentRef.current && pagesCount > 0 ? (
                <PdfThumbnailList
                  pdfDocument={pdfDocumentRef.current}
                  pagesCount={pagesCount}
                  pageLabels={pageLabels}
                  currentPage={currentPage}
                  onSelect={(pageNumber) => {
                    if (pdfViewerRef.current) pdfViewerRef.current.currentPageNumber = pageNumber
                  }}
                />
              ) : sidebarMode === 'outline' ? (
                outline.length > 0 ? (
                  <PdfOutlineTree items={outline} onSelect={handleOutlineSelect} />
                ) : (
                  <div className="grid min-h-[200px] place-items-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.03] p-6 text-center text-sm text-vast-soft">
                    This document does not include an outline.
                  </div>
                )
              ) : infoRows.length > 0 ? (
                <div className="space-y-2">
                  {infoRows.map(([label, value]) => (
                    <div key={label} className="rounded-[22px] border border-white/[0.08] bg-white/[0.035] p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-vast-soft">{label}</div>
                      <div className="mt-1 break-words text-sm text-white">{value}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid min-h-[200px] place-items-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.03] p-6 text-center text-sm text-vast-soft">
                  Document metadata will appear here after the PDF finishes loading.
                </div>
              )}
            </div>
          </aside>
        )}

        <section className="min-w-0 flex-1 overflow-hidden rounded-[30px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(15,17,22,0.94),rgba(9,11,15,0.98))] shadow-[0_20px_50px_rgba(0,0,0,0.25)]">
          <div className="relative flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3 text-xs text-vast-soft">
              <div className="flex min-w-0 items-center gap-3">
                <span className="truncate">Page {visiblePageLabel}</span>
                <span className="hidden sm:inline">Rotation {rotation}&deg;</span>
                {!printAllowed && <span className="rounded-full border border-vast-amber/30 bg-vast-amber/10 px-2 py-1 text-vast-amber">Print restricted</span>}
                {!copyAllowed && <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-white/70">Copy restricted</span>}
              </div>
              <div>
                {searchStatus === 'pending'
                  ? 'Searching...'
                  : searchStatus === 'not-found'
                    ? 'No matches'
                    : searchStatus === 'wrapped'
                      ? 'Wrapped search'
                      : searchQuery.trim()
                        ? `${searchMatches.total} matches`
                        : 'Ready'}
              </div>
            </div>

            <div className="relative min-h-0 flex-1">
              <div ref={containerRef} className="absolute inset-0 overflow-auto bg-[radial-gradient(circle_at_top,rgba(255,148,67,0.05),transparent_18%),linear-gradient(180deg,#101216,#0b0d12)] px-3 py-5 md:px-5">
                <div ref={viewerRef} className={`pdfViewer ${loadState === 'error' ? 'pointer-events-none opacity-0' : ''}`} />

                {loadState === 'loading' && (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-[rgba(8,9,12,0.72)] backdrop-blur-sm">
                    <div className="text-center">
                      <Loader2 className="mx-auto h-9 w-9 animate-spin text-vast-cyan" />
                      <div className="mt-4 text-lg font-semibold text-white">Loading PDF</div>
                      <div className="mt-2 max-w-md text-sm leading-6 text-vast-soft">
                        {downloadProgress
                          ? `Streaming the original authenticated response to protected temporary storage${downloadProgress.total > 0 ? ` · ${formatBytes(downloadProgress.received)} of ${formatBytes(downloadProgress.total)}` : ` · ${formatBytes(downloadProgress.received)}`}.`
                          : 'Preparing range-based page rendering, search indexes, and navigation targets.'}
                      </div>
                      {downloadProgress?.total ? (
                        <div className="mx-auto mt-4 h-1.5 w-64 overflow-hidden rounded-full bg-white/[0.08]">
                          <div
                            className="h-full rounded-full bg-vast-cyan transition-[width] duration-150"
                            style={{ width: `${Math.min(100, downloadProgress.received / downloadProgress.total * 100)}%` }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {passwordRequest && (
                  <div className="absolute inset-0 z-20 grid place-items-center bg-[rgba(8,9,12,0.82)] backdrop-blur-md p-6">
                    <form
                      className="w-full max-w-md rounded-[28px] border border-white/[0.1] bg-[#0d1015]/95 p-5 shadow-[0_28px_70px_rgba(0,0,0,0.36)]"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const trimmed = passwordValue.trim()
                        if (!trimmed) return
                        passwordRequest.submit(trimmed)
                      }}
                    >
                      <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,175,110,0.24)] bg-[rgba(255,154,82,0.12)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#ffd4b4]">
                        <FileText className="h-3.5 w-3.5" />Protected PDF
                      </div>
                      <div className="mt-4 text-xl font-semibold text-white">
                        {passwordRequest.reason === 'incorrect' ? 'Incorrect password' : 'Password required'}
                      </div>
                      <p className="mt-2 text-sm leading-6 text-vast-soft">
                        {passwordRequest.reason === 'incorrect'
                          ? 'The password was rejected by the document. Enter the correct password to continue loading this PDF.'
                          : 'This document is encrypted. Enter the password to unlock the built-in viewer.'}
                      </p>
                      <input
                        type="password"
                        value={passwordValue}
                        onChange={(event) => setPasswordValue(event.target.value)}
                        placeholder="Document password"
                        className="mt-5 h-12 w-full rounded-2xl border border-white/[0.1] bg-black/25 px-4 text-sm font-medium text-white outline-none transition focus:border-vast-cyan/40 focus:bg-black/[0.35]"
                      />
                      <div className="mt-5 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPasswordRequest(null)
                            setPasswordValue('')
                            setLoadState('error')
                            setLoadError('Password entry was cancelled.')
                            void loadingTaskRef.current?.destroy().catch(() => undefined)
                          }}
                          className="rounded-xl border border-white/[0.1] bg-white/[0.05] px-4 py-2 text-sm font-medium text-vast-soft hover:bg-white/[0.08] hover:text-white"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!passwordValue.trim()}
                          className="rounded-xl bg-vast-cyan px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          Unlock
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {loadState === 'error' && (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-[rgba(8,9,12,0.82)] p-6">
                    <InternalEmptyState
                      icon={FileText}
                      title="Unable to render this PDF"
                      description={loadError ?? 'The document could not be opened by the internal PDF viewer.'}
                      action={
                        <div className="flex flex-wrap justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void window.vast.pdf.openExternal(resourceId).then((result) => {
                                if (!result.ok) throw new Error(result.error || 'External PDF fallback failed.')
                              }).catch(() => handleOpenOriginal())
                            }}
                            className="vault-action-button"
                          >
                            <ExternalLink className="h-4 w-4" />Open externally
                          </button>
                          <button
                            type="button"
                            onClick={() => useBrowserStore.getState().navigateTab(
                              tab.id,
                              `${tab.url}${tab.url.includes('?') ? '&' : '?'}r=${Date.now()}`
                            )}
                            className="vault-action-button bg-vast-cyan text-black"
                          >
                            <Loader2 className="h-4 w-4" />Retry viewer
                          </button>
                        </div>
                      }
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
