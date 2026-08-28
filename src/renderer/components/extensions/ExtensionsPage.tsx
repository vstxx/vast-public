import { AlertTriangle, BadgeCheck, Check, ChevronDown, Code2, Compass, ExternalLink, FolderOpen, Info, Loader2, PackagePlus, Puzzle, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionCompatibility, VastExtensionInfo, VastExtensionMutationResult } from '../../../shared/types'
import type { VastNativePermission } from '../../../shared/extension-native-api'
import type { ExtensionPackagePreview, VastHubCatalogItem, VastHubCatalogResult } from '../../../shared/extension-marketplace'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { InternalEmptyState, InternalLoadingSkeleton, InternalPageHero, InternalPageSection, InternalPageShell } from '../internal/InternalPage'
import { useVastConfirm } from '../ui/useVastConfirm'

const DEVELOPER_MODE_KEY = 'vast.extensions.developer-mode'
const EXTENSION_PUBLISHER_URL = 'https://extensions.vastbrowser.com/dashboard'
const MANAGED_EXTENSION_ID = /^[a-p]{32}$/

function compatibilityStyle(value: ExtensionCompatibility): string {
  return value === 'compatible' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200' : value === 'partial' ? 'border-amber-400/20 bg-amber-400/10 text-amber-100' : 'border-red-400/20 bg-red-400/10 text-red-200'
}
function compatibilityLabel(value: ExtensionCompatibility): string { return value === 'compatible' ? 'Good compatibility' : value === 'partial' ? 'Partial compatibility' : 'Unsupported configuration' }
function hostLabel(value: string): string { return value === '<all_urls>' ? 'All websites' : value }
function sourceLabel(extension: VastExtensionInfo): string {
  if (extension.source === 'bundled') return 'From Vast Extensions'
  if (extension.source === 'hub') return 'From Vast Extensions'
  if (extension.source === 'local-vext') return extension.trust === 'official' ? 'Verified package installed from file' : 'Local package'
  return 'Developer extension'
}

function RuntimeBadge({ extension }: { extension: VastExtensionInfo }): JSX.Element {
  if (extension.native.state === 'pending-permission') return <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100"><ShieldCheck className="h-3 w-3" />Needs permission review</span>
  if (extension.native.state === 'running') return <span className="inline-flex items-center gap-1.5 rounded-full border border-vast-cyan/20 bg-vast-cyan/10 px-2.5 py-1 text-[11px] font-semibold text-vast-cyan"><Check className="h-3 w-3" />Vast integration running</span>
  if (extension.native.state === 'error' || extension.runtimeState === 'error') return <span className="inline-flex items-center gap-1.5 rounded-full border border-red-400/20 bg-red-400/10 px-2.5 py-1 text-[11px] font-semibold text-red-200"><AlertTriangle className="h-3 w-3" />Needs attention</span>
  if (extension.runtimeState === 'loaded') return <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200"><Check className="h-3 w-3" />Active</span>
  return <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-vast-soft">Disabled</span>
}

function UpdateBadge({ extension }: { extension: VastExtensionInfo }): JSX.Element | null {
  const labels: Partial<Record<VastExtensionInfo['update']['state'], string>> = { 'up-to-date': 'Up to date', checking: 'Checking…', available: 'Update available', updating: 'Updating…', 'pending-approval': 'Update needs approval', failed: 'Update failed' }
  const label = labels[extension.update.state]
  if (!label) return null
  const warning = extension.update.state === 'pending-approval' || extension.update.state === 'failed'
  return <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${warning ? 'border-amber-400/20 bg-amber-400/10 text-amber-100' : 'border-white/[0.08] bg-white/[0.04] text-vast-soft'}`}>{label}</span>
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }): JSX.Element {
  return <div className={`min-w-0 ${wide ? 'md:col-span-2' : ''}`}><div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-vast-soft">{label}</div><div className="mt-1 break-words leading-5 text-white/85">{value}</div></div>
}

interface ExtensionCardProps {
  extension: VastExtensionInfo
  developerMode: boolean
  busy: boolean
  onToggle: () => void
  onReload: () => void
  onRemove: () => void
  onApprove: () => void
  onPermission: (permission: VastNativePermission, granted: boolean) => void
  onApproveUpdate: () => void
  onCheckUpdate: () => void
}

function ExtensionCard({ extension, developerMode, busy, onToggle, onReload, onRemove, onApprove, onPermission, onApproveUpdate, onCheckUpdate }: ExtensionCardProps): JSX.Element {
  const displayedError = extension.update.error ?? extension.native.error ?? extension.error
  return <article className="extensions-flat-card vast-glass-panel internal-page-enter rounded-[26px] p-5" data-extension-id={extension.id}>
    <div className="flex min-w-0 items-start gap-4">
      <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.045] text-vast-cyan">{extension.iconDataUrl ? <img src={extension.iconDataUrl} alt="" className="h-9 w-9 object-contain" /> : <Puzzle className="h-6 w-6" />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-lg font-semibold text-white">{extension.name}</h2><span className="text-xs font-medium text-vast-soft">{extension.version}</span>{extension.trust === 'official' && <BadgeCheck className="h-4 w-4 text-vast-cyan" aria-label="Verified Vast package" />}</div>
        <p className="mt-1 text-xs font-medium text-white/60">{sourceLabel(extension)}{extension.publisherName ? ` · by ${extension.publisherName}` : ''}</p>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-vast-soft">{extension.description || 'This extension does not provide a description.'}</p>
        <div className="mt-3 flex flex-wrap gap-2"><span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${compatibilityStyle(extension.compatibility)}`}>{compatibilityLabel(extension.compatibility)}</span><RuntimeBadge extension={extension} /><UpdateBadge extension={extension} /><span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-vast-soft">{extension.kind === 'chrome' ? 'Chrome' : extension.kind === 'vast' ? 'Vast Native' : 'Chrome + Vast'}</span></div>
      </div>
    </div>

    {displayedError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-400/15 bg-red-400/[0.07] px-3.5 py-3 text-xs leading-5 text-red-100"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{displayedError}</span></div>}
    {extension.update.state === 'pending-approval' && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/15 bg-amber-400/[0.06] p-3.5"><div><div className="text-xs font-semibold text-amber-100">Version {extension.update.availableVersion} requests additional access</div><div className="mt-1 text-[11px] text-vast-soft">The installed version remains active until you approve the update.</div></div><button type="button" disabled={busy} onClick={onApproveUpdate} className="vault-action-button">Review update</button></div>}
    {extension.native.requestedPermissions.length > 0 && <div className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3.5"><div className="flex items-center justify-between gap-3"><div><div className="text-xs font-semibold text-white">Vast permissions</div><div className="mt-1 text-[11px] text-vast-soft">Native access is separate from website access.</div></div>{extension.native.state === 'pending-permission' && <button type="button" disabled={busy} onClick={onApprove} className="vault-action-button">Review & approve</button>}</div><div className="mt-3 space-y-2">{extension.native.permissionDetails.map((permission) => { const granted = extension.native.grantedPermissions.includes(permission.id); return <label key={permission.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2"><span><span className="block text-xs font-medium text-white">{permission.title}</span><span className="block text-[11px] text-vast-soft">{permission.description}</span></span><input type="checkbox" aria-label={`${granted ? 'Revoke' : 'Allow'} ${permission.title}`} checked={granted} disabled={busy} onChange={(event) => onPermission(permission.id, event.target.checked)} /></label> })}</div></div>}
    <details className="group mt-4 rounded-2xl border border-white/[0.07] bg-black/10"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-xs font-semibold text-white">Details<ChevronDown className="h-3.5 w-3.5 text-vast-soft transition group-open:rotate-180" /></summary><div className="grid gap-3 border-t border-white/[0.07] p-3.5 text-xs md:grid-cols-2"><Detail label="Extension ID" value={extension.id} /><Detail label="Install source" value={sourceLabel(extension)} />{extension.category && <Detail label="Category" value={extension.category} />}<Detail label="Chrome runtime" value={`${extension.chrome.state} · ${extension.chrome.loadedSessionCount}/${extension.chrome.eligibleSessionCount} persistent sessions`} /><Detail label="Vast integration" value={`${extension.native.state}${extension.native.apiVersion ? ` · API v${extension.native.apiVersion}` : ''}`} /><Detail label="Manifest" value={`Version ${extension.manifestVersion}`} /><Detail label="Chrome permissions" value={extension.permissions.join(', ') || 'None'} /><Detail label="Website access" value={extension.hostPermissions.map(hostLabel).join(', ') || 'Only declared content-script sites'} /><Detail label="Update status" value={extension.firstParty ? 'Updated with Vast' : extension.update.state.replaceAll('-', ' ')} />{developerMode && <Detail label="Installed path" value={extension.path} wide />}{extension.compatibilityWarnings.length > 0 && <Detail label="Compatibility notes" value={extension.compatibilityWarnings.join(' ')} wide />}</div></details>
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">{extension.source === 'hub' && <button type="button" disabled={busy} onClick={onCheckUpdate} className="vault-action-button"><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />Check update</button>}{developerMode && extension.source === 'unpacked' && <button type="button" disabled={busy} onClick={onReload} className="vault-action-button"><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />Reload</button>}<div className="extensions-enabled-control"><span>Enabled</span><button type="button" role="switch" aria-checked={extension.enabled} aria-label={`${extension.enabled ? 'Disable' : 'Enable'} ${extension.name}`} disabled={busy} onClick={onToggle} className={`extensions-enabled-switch ${extension.enabled ? 'is-active' : ''}`}><span /></button></div>{extension.removable && <button type="button" disabled={busy} onClick={onRemove} className="vault-danger-button"><Trash2 className="h-4 w-4" />Remove</button>}</div>
  </article>
}

function CatalogCard({ item, busy, onInstall }: { item: VastHubCatalogItem; busy: boolean; onInstall: () => void }): JSX.Element {
  return <article className="extensions-flat-card vast-glass-panel flex min-h-56 flex-col rounded-[26px] p-5"><div className="flex items-start gap-3"><div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.035] text-vast-cyan">{item.iconUrl ? <img src={item.iconUrl} alt="" className="h-8 w-8 object-contain" /> : <Puzzle className="h-5 w-5" />}</div><div className="min-w-0"><h3 className="truncate font-semibold text-white">{item.name}</h3><p className="mt-1 truncate text-xs text-vast-soft">{item.publisher.name}{item.publisher.verified ? ' · Verified' : ''}</p></div></div><p className="mt-4 line-clamp-3 flex-1 text-sm leading-6 text-vast-soft">{item.summary}</p><div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4"><span className="text-[11px] font-medium text-white/55">{item.kind === 'hybrid' ? 'Chrome + Vast' : item.kind === 'vast' ? 'Vast Native' : 'Chrome'} · {item.version}</span><button type="button" disabled={busy || item.installed} onClick={onInstall} aria-label={`Install ${item.name}`} className="vault-action-button disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}{item.installed ? 'Installed' : 'Install'}</button></div></article>
}

function installDetail(preview: ExtensionPackagePreview): string {
  const access = [...preview.permissions.chrome, ...preview.permissions.hosts.map(hostLabel), ...preview.permissions.vast]
  const trust = preview.trust === 'official' ? `Verified Vast package from ${preview.publisherName}.` : 'Local package. Vast Extensions has not authenticated its publisher.'
  const escalationCount = preview.permissionEscalation.chrome.length + preview.permissionEscalation.hosts.length + preview.permissionEscalation.vast.length
  return `${trust}\n\nRequested access:\n${access.length > 0 ? access.map((item) => `• ${item}`).join('\n') : '• No additional browser or Vast permissions'}${preview.isUpdate && escalationCount > 0 ? '\n\nThis update requests additional access.' : ''}`
}

export function ExtensionsPage({ requestedInstallId, requestedExtensionId }: { requestedInstallId?: string; requestedExtensionId?: string }): JSX.Element {
  const runtime = useBrowserRuntime()
  const confirm = useVastConfirm()
  const [tab, setTab] = useState<'installed' | 'explore'>('installed')
  const [extensions, setExtensions] = useState<VastExtensionInfo[]>([])
  const [catalog, setCatalog] = useState<VastHubCatalogResult | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(true)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [developerMode, setDeveloperMode] = useState(() => localStorage.getItem(DEVELOPER_MODE_KEY) === '1')
  const handledDeepLink = useRef<string | null>(null)
  const catalogRequested = useRef(false)
  const catalogRequestId = useRef(0)
  const catalogRequestStartedAt = useRef(0)
  const queryRef = useRef(query)
  const categoryRef = useRef(category)
  queryRef.current = query
  categoryRef.current = category

  const refresh = useCallback(async (): Promise<void> => { const result = await window.vast.extensions.list(); if (result.ok) { setExtensions(result.extensions ?? []); setError(null) } else setError(result.error ?? 'Could not load installed extensions.'); setLoading(false) }, [])
  const loadCatalog = useCallback(async (nextQuery?: string, nextCategory?: string): Promise<void> => {
    const requestId = ++catalogRequestId.current
    catalogRequestStartedAt.current = Date.now()
    const resolvedQuery = nextQuery ?? queryRef.current
    const resolvedCategory = nextCategory ?? categoryRef.current
    setCatalogLoading(true)
    const result = await window.vast.extensions.catalog({
      query: resolvedQuery || undefined,
      category: resolvedCategory || undefined,
      page: 1,
      sort: resolvedQuery ? 'updated' : 'popular'
    })
    if (requestId !== catalogRequestId.current) return
    if (result.ok && result.catalog) {
      setCatalog(result.catalog)
      setCatalogError(null)
    } else {
      setCatalogError(result.error ?? 'Vast Extensions is currently unavailable.')
    }
    setCatalogLoading(false)
  }, [])
  useEffect(() => {
    void refresh()
    return window.vast.extensions.onChanged(() => {
      void refresh()
      if (catalogRequested.current) void loadCatalog()
    })
  }, [loadCatalog, refresh])
  useEffect(() => {
    if (tab !== 'explore') return
    catalogRequested.current = true
    void loadCatalog()
    const refreshVisibleCatalog = (): void => {
      if (document.visibilityState === 'visible' && Date.now() - catalogRequestStartedAt.current > 2_000) void loadCatalog()
    }
    window.addEventListener('focus', refreshVisibleCatalog)
    document.addEventListener('visibilitychange', refreshVisibleCatalog)
    return () => {
      window.removeEventListener('focus', refreshVisibleCatalog)
      document.removeEventListener('visibilitychange', refreshVisibleCatalog)
    }
  }, [loadCatalog, tab])

  const run = useCallback(async (key: string, operation: () => Promise<VastExtensionMutationResult>): Promise<void> => { setBusyId(key); setError(null); try { const result = await operation(); if (!result.ok) setError(result.error ?? 'The extension operation failed.'); await refresh() } catch (operationError) { setError(operationError instanceof Error ? operationError.message : 'The extension operation failed.') } finally { setBusyId(null) } }, [refresh])
  const confirmPreview = useCallback(async (preview: ExtensionPackagePreview): Promise<void> => { const approved = await confirm(`${preview.isUpdate ? 'Update' : 'Install'} ${preview.name}?`, installDetail(preview), preview.isUpdate ? 'Update' : 'Install'); if (!approved) { await window.vast.extensions.cancelInstall(preview.token); return } await run(preview.extensionId, () => window.vast.extensions.confirmInstall(preview.token)); setTab('installed') }, [confirm, run])
  const prepareHub = useCallback(async (id: string): Promise<void> => { setBusyId(id); setCatalogError(null); try { const result = await window.vast.extensions.prepareHubInstall(id); if (!result.ok || !result.preview) { setCatalogError(result.error ?? 'Could not prepare extension installation.'); return } await confirmPreview(result.preview) } finally { setBusyId(null) } }, [confirmPreview])
  useEffect(() => { if (!requestedInstallId || handledDeepLink.current === requestedInstallId || !MANAGED_EXTENSION_ID.test(requestedInstallId)) return; handledDeepLink.current = requestedInstallId; setTab('explore'); void prepareHub(requestedInstallId) }, [prepareHub, requestedInstallId])
  useEffect(() => {
    if (loading || !requestedExtensionId || !MANAGED_EXTENSION_ID.test(requestedExtensionId) || !extensions.some((extension) => extension.id === requestedExtensionId)) return
    setTab('installed')
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-extension-id="${requestedExtensionId}"]`)?.scrollIntoView({ block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [extensions, loading, requestedExtensionId])

  const installPackage = async (): Promise<void> => { setBusyId('package'); const result = await window.vast.extensions.installPackage(); setBusyId(null); if (!result.ok) { setError(result.error ?? 'Could not read extension package.'); return } if (result.preview) await confirmPreview(result.preview) }
  const remove = async (extension: VastExtensionInfo): Promise<void> => { const detail = extension.source === 'unpacked' ? 'Vast will unload it and forget the installation. The developer source directory will not be deleted.' : extension.source === 'bundled' ? 'Vast will remove this extension from Installed. You can install it again from Explore.' : 'Vast will remove the managed package, permission grants, contributions, and data stored by this extension.'; if (await confirm(`Remove ${extension.name}?`, detail, 'Remove')) await run(extension.id, () => window.vast.extensions.remove(extension.id)) }
  const approvePermissions = async (extension: VastExtensionInfo): Promise<void> => { if (await confirm(`Allow ${extension.name} to integrate with Vast?`, extension.native.permissionDetails.map((permission) => permission.title).join('\n'), 'Allow')) await run(extension.id, () => window.vast.extensions.approvePermissions(extension.id, extension.native.requestedPermissions)) }
  const setPermission = async (extension: VastExtensionInfo, permission: VastNativePermission, granted: boolean): Promise<void> => { if (granted) { const details = extension.native.permissionDetails.find((item) => item.id === permission); if (!await confirm(`Allow ${extension.name}?`, details?.description ?? permission, 'Allow')) return } await run(extension.id, () => window.vast.extensions.setPermission(extension.id, permission, granted)) }
  const checkUpdates = async (id?: string): Promise<void> => { setBusyId(id ?? 'updates'); const result = await window.vast.extensions.checkForUpdates(id); if (!result.ok) setError(result.error ?? 'Could not check for updates.'); await refresh(); setBusyId(null) }
  const setDeveloper = (enabled: boolean): void => { setDeveloperMode(enabled); localStorage.setItem(DEVELOPER_MODE_KEY, enabled ? '1' : '0') }

  return <InternalPageShell className="extensions-page-surface labs-page-surface bg-[#06070a] p-5 lg:p-6" data-testid="extensions-page"><div className="mx-auto max-w-7xl space-y-5">
    <InternalPageHero title="Extensions" description="Discover and manage Chrome-compatible, Vast-native, and hybrid extensions." actions={<div className="flex w-full flex-wrap items-center justify-end gap-2 lg:w-auto"><button type="button" disabled={busyId === 'updates'} onClick={() => { void checkUpdates() }} className="vault-action-button min-w-0 justify-center px-4"><RefreshCw className={`h-4 w-4 ${busyId === 'updates' ? 'animate-spin' : ''}`} />Check for updates</button><button type="button" role="switch" aria-checked={developerMode} data-testid="extensions-developer-mode" onClick={() => setDeveloper(!developerMode)} className={`vault-action-button min-w-0 justify-center px-4 ${developerMode ? 'border-vast-cyan/30 text-vast-cyan' : ''}`}><Code2 className="h-4 w-4" />Developer mode<span className="text-[11px] text-vast-soft">{developerMode ? 'On' : 'Off'}</span></button>{developerMode && <><button type="button" disabled={busyId !== null} onClick={() => { void installPackage() }} className="vault-action-button min-w-0 justify-center px-4"><PackagePlus className="h-4 w-4" />Install package</button><button type="button" disabled={busyId !== null} onClick={() => { void run('load', () => window.vast.extensions.loadUnpacked()) }} className="vault-action-button min-w-0 justify-center px-4" data-testid="load-unpacked-extension"><FolderOpen className="h-4 w-4" />Load unpacked</button></>}</div>} />
    <div role="tablist" aria-label="Extension sections" className="extensions-tablist"><button type="button" role="tab" aria-selected={tab === 'installed'} onClick={() => setTab('installed')} className={`extensions-tab ${tab === 'installed' ? 'is-active' : ''}`}>Installed</button><button type="button" role="tab" aria-selected={tab === 'explore'} onClick={() => setTab('explore')} className={`extensions-tab ${tab === 'explore' ? 'is-active' : ''}`}>Explore</button></div>
    {tab === 'installed' ? <>
      {error && <div role="alert" className="flex items-start gap-3 rounded-2xl border border-red-400/15 bg-red-400/[0.07] px-4 py-3 text-sm leading-6 text-red-100"><AlertTriangle className="mt-1 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      {loading ? <InternalLoadingSkeleton title="Loading extensions" lines={4} /> : extensions.length === 0 ? <InternalEmptyState icon={Puzzle} title="No extensions installed" description="Explore Vast Extensions, or enable Developer Mode to install a local package or unpacked extension." action={<button type="button" onClick={() => setTab('explore')} className="vault-action-button"><Compass className="h-4 w-4" />Explore extensions</button>} /> : <section className="space-y-4" aria-label="Installed extensions">{extensions.map((extension) => <ExtensionCard key={extension.id} extension={extension} developerMode={developerMode} busy={busyId === extension.id} onToggle={() => { void run(extension.id, () => extension.enabled ? window.vast.extensions.disable(extension.id) : window.vast.extensions.enable(extension.id)) }} onReload={() => { void run(extension.id, () => window.vast.extensions.reload(extension.id)) }} onRemove={() => { void remove(extension) }} onApprove={() => { void approvePermissions(extension) }} onPermission={(permission, granted) => { void setPermission(extension, permission, granted) }} onCheckUpdate={() => { void checkUpdates(extension.id) }} onApproveUpdate={() => { void run(extension.id, () => window.vast.extensions.approveUpdate(extension.id)) }} />)}</section>}
      <InternalPageSection icon={Info} title="Security boundary" description="Extensions run only in eligible persistent workspaces and sanctioned Vast surfaces."><div className="grid gap-3 text-xs leading-5 text-vast-soft md:grid-cols-3"><div className="extensions-subpanel rounded-2xl p-3.5"><strong className="mb-1 block text-white">Private stays private</strong>Private and in-memory workspaces do not expose tabs or extension surfaces.</div><div className="extensions-subpanel rounded-2xl p-3.5"><strong className="mb-1 block text-white">Signed Hub releases</strong>Official packages require pinned metadata and package signatures.</div><div className="extensions-subpanel rounded-2xl p-3.5"><strong className="mb-1 block text-white">Local remains local</strong>Unpacked sources are never deleted; local packages do not auto-update.</div></div></InternalPageSection>
    </> : <>
      <form onSubmit={(event) => { event.preventDefault(); void loadCatalog() }} className="extensions-search-panel vast-glass-panel"><label className="extensions-search-field"><Search className="h-4 w-4 shrink-0 text-vast-soft" /><input value={query} onChange={(event) => setQuery(event.target.value.slice(0, 128))} placeholder="Search Vast Extensions" aria-label="Search Vast Extensions" className="h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-vast-soft" /></label><button type="submit" disabled={catalogLoading} className="extensions-search-button vault-action-button">{catalogLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Search</button></form>
      {catalog?.categories && <div className="flex flex-wrap gap-2" aria-label="Extension categories"><button type="button" onClick={() => { setCategory(''); void loadCatalog(query, '') }} className={`extensions-filter-chip ${!category ? 'is-active' : ''}`}>All</button>{catalog.categories.map((item) => <button key={item} type="button" onClick={() => { setCategory(item); void loadCatalog(query, item) }} className={`extensions-filter-chip ${category === item ? 'is-active' : ''}`}>{item}</button>)}</div>}
      {catalogError && <div role="alert" className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-100">{catalogError} Installed and local extensions continue to work offline.</div>}
      {catalogLoading && !catalog ? <InternalLoadingSkeleton title="Loading Vast Extensions" lines={4} /> : catalog && catalog.items.length > 0 ? <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Vast Extensions catalog">{catalog.items.map((item) => <CatalogCard key={item.id} item={item} busy={busyId === item.id} onInstall={() => { void prepareHub(item.id) }} />)}</section> : catalog && !catalogLoading && <InternalEmptyState icon={Compass} title="No extensions found" description="Try a shorter search or another category." />}
    </>}
    <footer className="extensions-developer-footer"><span>Looking to create an extension?</span><button type="button" onClick={() => runtime.openUrlInNewTab(EXTENSION_PUBLISHER_URL)} className="extensions-developer-link">Visit extensions.vastbrowser.com/dashboard<ExternalLink className="h-3 w-3" /></button></footer>
  </div></InternalPageShell>
}
