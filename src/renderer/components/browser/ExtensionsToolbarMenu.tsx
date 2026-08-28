import {
  ArrowLeft,
  BadgeCheck,
  MoreHorizontal,
  Puzzle,
  Power,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent } from 'react'
import { INTERNAL_EXTENSIONS_URL } from '../../../shared/constants'
import { matchesExtensionMatchPattern } from '../../../shared/extension-match-pattern'
import { partitionForWorkspace, resolveWorkspaceIdentity } from '../../../shared/workspace-identity'
import type { VastExtensionInfo, VastExtensionMutationResult, VastExtensionSurface, VastExtensionSurfaceKind } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { selectActiveTab, selectActiveWorkspace, useBrowserStore } from '../../store/browser-store'
import { IconButton } from '../ui/IconButton'
import { useVastConfirm } from '../ui/useVastConfirm'

interface ExtensionsToolbarMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ActionMenuState {
  id: string
  top: number
}

function extensionState(extension: VastExtensionInfo, activeUrl?: string): { label: string; tone: string } {
  if (!extension.enabled) return { label: 'Disabled', tone: 'bg-white/25' }
  if (extension.runtimeState === 'error' || extension.native.state === 'error') return { label: 'Needs attention', tone: 'bg-red-300' }
  if (extension.native.state === 'pending-permission') return { label: 'Needs permission', tone: 'bg-amber-300' }
  if (activeUrl && extension.hostPermissions.some((pattern) => matchesExtensionMatchPattern(activeUrl, pattern))) return { label: 'Active on this site', tone: 'bg-emerald-300' }
  return { label: 'Active', tone: 'bg-emerald-300' }
}

function ExtensionIcon({ extension, size = 'small' }: { extension: VastExtensionInfo; size?: 'small' | 'large' }): JSX.Element {
  const box = size === 'large' ? 'h-12 w-12 rounded-2xl' : 'h-9 w-9 rounded-xl'
  const image = size === 'large' ? 'h-8 w-8' : 'h-6 w-6'
  return (
    <div className={`grid shrink-0 place-items-center overflow-hidden border border-white/[0.07] bg-white/[0.035] text-vast-soft ${box}`}>
      {extension.iconDataUrl
        ? <img src={extension.iconDataUrl} alt="" className={`${image} object-contain`} />
        : <Puzzle className={size === 'large' ? 'h-5 w-5' : 'h-4 w-4'} />}
    </div>
  )
}

export function ExtensionsToolbarMenu({ open, onOpenChange }: ExtensionsToolbarMenuProps): JSX.Element {
  const runtime = useBrowserRuntime()
  const confirm = useVastConfirm()
  const activeWorkspace = useBrowserStore(selectActiveWorkspace)
  const activeTab = useBrowserStore(selectActiveTab)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [extensions, setExtensions] = useState<VastExtensionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [surface, setSurface] = useState<VastExtensionSurface | null>(null)
  const [surfaceLoading, setSurfaceLoading] = useState(false)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null)

  const identity = activeWorkspace ? resolveWorkspaceIdentity(activeWorkspace) : undefined
  const privateWorkspace = Boolean(activeWorkspace?.isPrivate || identity?.sessionMode === 'ephemeral')
  const workspacePartition = activeWorkspace ? partitionForWorkspace(activeWorkspace) : 'persist:vast-default'
  const selected = extensions.find((extension) => extension.id === selectedId)
  const orderedExtensions = useMemo(() => [...extensions].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  }), [extensions])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.vast.extensions.list()
      if (!result.ok) throw new Error(result.error ?? 'Could not load extensions.')
      setExtensions(result.extensions ?? [])
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not load extensions.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    return window.vast.extensions.onChanged(() => { void refresh() })
  }, [open, refresh])

  useEffect(() => {
    if (open) return
    setSelectedId(null)
    setSurface(null)
    setSurfaceError(null)
    setActionMenu(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (actionMenu) setActionMenu(null)
      else if (selectedId) {
        setSelectedId(null)
        setSurface(null)
        setSurfaceError(null)
      } else onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [actionMenu, onOpenChange, open, selectedId])

  const openSurface = async (extension: VastExtensionInfo, preferred?: VastExtensionSurfaceKind): Promise<void> => {
    setSelectedId(extension.id)
    setActionMenu(null)
    setSurface(null)
    setSurfaceError(null)
    if (!extension.enabled) return
    const kind = preferred ?? (extension.ui.popup ? 'popup' : extension.ui.options ? 'options' : undefined)
    if (!kind) return
    setSurfaceLoading(true)
    try {
      const result = await window.vast.extensions.prepareSurface(extension.id, kind, workspacePartition)
      if (!result.ok) throw new Error(result.error ?? 'Could not open the extension interface.')
      if (result.surface) setSurface(result.surface)
    } catch (surfaceFailure) {
      setSurfaceError(surfaceFailure instanceof Error ? surfaceFailure.message : 'Could not open the extension interface.')
    } finally {
      setSurfaceLoading(false)
    }
  }

  const mutate = async (extension: VastExtensionInfo, operation: () => Promise<VastExtensionMutationResult>): Promise<void> => {
    setBusyId(extension.id)
    setError(null)
    setActionMenu(null)
    try {
      const result = await operation()
      if (!result.ok) throw new Error(result.error ?? 'The extension operation failed.')
      if (!result.extension?.enabled && selectedId === extension.id) {
        setSurface(null)
        setSurfaceError(null)
      }
      await refresh()
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : 'The extension operation failed.')
    } finally {
      setBusyId(null)
    }
  }

  const manageExtensions = (extension?: VastExtensionInfo): void => {
    onOpenChange(false)
    runtime.openUrlInNewTab(extension ? `${INTERNAL_EXTENSIONS_URL}?extension=${encodeURIComponent(extension.id)}` : INTERNAL_EXTENSIONS_URL)
  }

  const removeExtension = async (extension: VastExtensionInfo): Promise<void> => {
    setActionMenu(null)
    const approved = await confirm(
      `Remove ${extension.name}?`,
      extension.source === 'unpacked'
        ? 'Vast will unload the extension and forget this installation. Its developer source directory will stay untouched.'
        : 'Vast will remove this extension, its permissions, contributions, and locally stored extension data.',
      'Remove'
    )
    if (!approved) return
    await mutate(extension, () => window.vast.extensions.remove(extension.id))
    if (selectedId === extension.id) setSelectedId(null)
  }

  const toggleActionMenu = (event: ReactMouseEvent<HTMLButtonElement>, id: string): void => {
    event.stopPropagation()
    if (actionMenu?.id === id) {
      setActionMenu(null)
      return
    }
    const root = rootRef.current?.getBoundingClientRect()
    const button = event.currentTarget.getBoundingClientRect()
    const top = root ? Math.max(54, Math.min(button.top - root.top, Math.max(54, root.height - 224))) : 54
    setActionMenu({ id, top })
  }

  const actionExtension = actionMenu ? extensions.find((extension) => extension.id === actionMenu.id) : undefined
  const selectedState = selected ? extensionState(selected, activeTab?.url) : undefined

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        tooltip={privateWorkspace ? 'Extensions are unavailable in private workspaces' : 'Extensions'}
        aria-label="Extensions"
        aria-haspopup="dialog"
        aria-expanded={open}
        active={open}
        disabled={privateWorkspace}
        data-testid="extensions-toolbar-button"
        onClick={() => onOpenChange(!open)}
      >
        <Puzzle className="h-4 w-4" />
      </IconButton>

      {open && (
        <section
          role="dialog"
          aria-label="Extensions"
          data-testid="extensions-toolbar-menu"
          className="extensions-toolbar-menu absolute right-0 top-11 z-[70] flex w-[23rem] max-w-[calc(100vw-1rem)] flex-col overflow-visible rounded-2xl border border-white/[0.1] bg-[#0a0b0f]/[0.985] text-white"
        >
          <header className="flex h-[3.25rem] shrink-0 items-center gap-2 border-b border-white/[0.07] px-3">
            {selected ? (
              <button type="button" aria-label="Back to extensions" onClick={() => { setSelectedId(null); setSurface(null); setSurfaceError(null) }} className="grid h-8 w-8 place-items-center rounded-lg text-vast-soft transition hover:bg-white/[0.06] hover:text-white">
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : <Puzzle className="ml-1 h-4 w-4 text-vast-soft" />}
            <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">{selected?.name ?? 'Extensions'}</div>
            <button type="button" onClick={() => manageExtensions(selected)} className="grid h-8 w-8 place-items-center rounded-lg text-vast-soft transition hover:bg-white/[0.06] hover:text-white" aria-label={selected ? `Manage ${selected.name}` : 'Manage extensions'} title={selected ? 'Manage extension' : 'Manage extensions'}>
              <Settings2 className="h-4 w-4" />
            </button>
          </header>

          {selected ? (
            <div className="min-h-0">
              {surfaceLoading ? (
                <div className="grid h-72 place-items-center"><RefreshCw className="h-4 w-4 animate-spin text-vast-soft" /></div>
              ) : surface ? (
                <webview
                  key={`${surface.partition}-${surface.src}`}
                  src={surface.src}
                  partition={surface.partition}
                  className="extension-toolbar-surface block h-[25rem] max-h-[calc(100vh-8rem)] w-full rounded-b-2xl bg-[#0a0b0f]"
                />
              ) : (
                <div className="p-4">
                  <div className="flex items-center gap-3">
                    <ExtensionIcon extension={selected} size="large" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div className="truncate text-sm font-semibold">{selected.name}</div>
                        {selected.trust === 'official' && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-vast-cyan" aria-label={selected.firstParty ? 'Official Vast extension' : 'Verified extension'} />}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-vast-soft">
                        <span className={`h-1.5 w-1.5 rounded-full ${selectedState?.tone}`} />
                        <span>{selectedState?.label}</span>
                        <span className="text-white/20">·</span>
                        <span>v{selected.version}</span>
                      </div>
                    </div>
                  </div>
                  <p className="mt-4 text-xs leading-5 text-white/55">{selected.description || 'This extension does not provide a custom popup. Use Manage extension for permissions and installation details.'}</p>
                  {surfaceError && <div role="alert" className="mt-3 rounded-xl border border-red-400/15 bg-red-400/[0.06] px-3 py-2.5 text-xs leading-5 text-red-100">{surfaceError}</div>}
                  <div className="mt-4 grid gap-2">
                    {selected.ui.options && selected.enabled && <button type="button" onClick={() => { void openSurface(selected, 'options') }} className="extensions-toolbar-primary-action"><SlidersHorizontal className="h-4 w-4" />Extension settings</button>}
                    <button type="button" onClick={() => manageExtensions(selected)} className="extensions-toolbar-secondary-action"><Settings2 className="h-4 w-4" />Manage extension</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {error && <div role="alert" className="mx-3 mt-3 rounded-xl border border-red-400/15 bg-red-400/[0.06] px-3 py-2 text-xs leading-5 text-red-100">{error}</div>}
              <div className="max-h-[22rem] min-h-20 overflow-y-auto overscroll-contain p-2" role="menu" aria-label="Installed extensions">
                {loading && extensions.length === 0 ? (
                  <div className="grid h-24 place-items-center"><RefreshCw className="h-4 w-4 animate-spin text-vast-soft" /></div>
                ) : orderedExtensions.length === 0 ? (
                  <div className="px-4 py-8 text-center"><Puzzle className="mx-auto h-5 w-5 text-white/25" /><div className="mt-3 text-xs font-medium text-white/70">No extensions installed</div><button type="button" onClick={() => manageExtensions()} className="mt-2 text-[11px] font-medium text-vast-cyan hover:text-white">Explore Vast Extensions</button></div>
                ) : orderedExtensions.map((extension) => {
                  const state = extensionState(extension, activeTab?.url)
                  const busy = busyId === extension.id
                  return (
                    <div key={extension.id} className="extensions-toolbar-row group relative flex min-h-[3.5rem] items-center rounded-xl">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={busy}
                        onClick={() => { void openSurface(extension) }}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 pl-2 pr-1 text-left outline-none transition hover:bg-white/[0.055] focus-visible:bg-white/[0.065] disabled:opacity-50"
                      >
                        <ExtensionIcon extension={extension} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-white/90">{extension.name}</span>
                            {extension.trust === 'official' && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-vast-cyan" aria-label={extension.firstParty ? 'Official Vast extension' : 'Verified extension'} />}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-vast-soft"><span className={`h-1.5 w-1.5 rounded-full ${state.tone}`} />{state.label}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`More actions for ${extension.name}`}
                        aria-haspopup="menu"
                        aria-expanded={actionMenu?.id === extension.id}
                        disabled={busy}
                        onClick={(event) => toggleActionMenu(event, extension.id)}
                        className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/35 outline-none transition hover:bg-white/[0.07] hover:text-white focus-visible:bg-white/[0.07] disabled:opacity-40"
                      >
                        {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                      </button>
                    </div>
                  )
                })}
              </div>
              <footer className="flex h-11 shrink-0 items-center justify-between border-t border-white/[0.07] px-3 text-[11px] text-vast-soft">
                <span>{extensions.length} installed</span>
                <button type="button" onClick={() => manageExtensions()} className="font-medium text-white/65 transition hover:text-white">Manage extensions</button>
              </footer>
            </>
          )}

          {actionMenu && actionExtension && (
            <div role="menu" aria-label={`Actions for ${actionExtension.name}`} className="extensions-toolbar-actions absolute right-2 z-20 max-h-[calc(100vh-5.5rem)] w-52 overflow-y-auto rounded-xl border border-white/[0.1] bg-[#101116] p-1.5" style={{ top: actionMenu.top }}>
              {actionExtension.ui.popup && actionExtension.enabled && <MenuAction label="Open extension" icon={Puzzle} onClick={() => { void openSurface(actionExtension, 'popup') }} />}
              {actionExtension.ui.options && actionExtension.enabled && <MenuAction label="Extension settings" icon={SlidersHorizontal} onClick={() => { void openSurface(actionExtension, 'options') }} />}
              <MenuAction label={actionExtension.enabled ? 'Disable extension' : 'Enable extension'} icon={Power} onClick={() => { void mutate(actionExtension, () => actionExtension.enabled ? window.vast.extensions.disable(actionExtension.id) : window.vast.extensions.enable(actionExtension.id)) }} />
              {!actionExtension.firstParty && <MenuAction label="Reload extension" icon={RefreshCw} disabled={!actionExtension.enabled} onClick={() => { void mutate(actionExtension, () => window.vast.extensions.reload(actionExtension.id)) }} />}
              <MenuAction label="Manage extension" icon={Settings2} onClick={() => manageExtensions(actionExtension)} />
              {actionExtension.removable && <><div className="my-1 border-t border-white/[0.07]" /><MenuAction label="Remove from Vast" icon={Trash2} danger onClick={() => { void removeExtension(actionExtension) }} /></>}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function MenuAction({ label, icon: Icon, onClick, disabled = false, danger = false }: {
  label: string
  icon: ComponentType<{ className?: string }>
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}): JSX.Element {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-xs outline-none transition disabled:cursor-not-allowed disabled:opacity-35 ${danger ? 'text-red-200 hover:bg-red-400/[0.08]' : 'text-white/75 hover:bg-white/[0.06] hover:text-white'}`}>
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  )
}
