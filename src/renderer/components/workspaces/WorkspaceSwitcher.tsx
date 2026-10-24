import { Palette, Plus, Trash2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useBrowserStore } from '../../store/browser-store'
import { WorkspaceAppearancePicker } from './WorkspaceAppearancePicker'
import { WorkspaceIcon } from './WorkspaceIcon'

const COLLAPSED_KEY = 'vast:workspace-switcher-collapsed'
const MOVE_MS = 240
const FADE_OUT_MS = 140
const FADE_IN_MS = 200
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const NEW_WORKSPACE_ROW = '__new-workspace__'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Remembering the state is a convenience only.
  }
}

function motionAllowed(animations: boolean): boolean {
  return animations && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface RowBox { top: number; left: number; width: number; height: number }

// Layout snapshot taken just before a collapse/expand commits, so the layout
// effect can animate every row from where it was (FLIP: transform/opacity only).
interface Transition {
  kind: 'collapse' | 'expand'
  boxes: Map<string, RowBox>
  rootHeight: number
}

export function WorkspaceSwitcher({ compact, followRef }: { compact?: boolean; followRef?: RefObject<HTMLElement | null> }): JSX.Element {
  const workspaces = useBrowserStore((state) => state.workspaces)
  const activeWorkspaceId = useBrowserStore((state) => state.activeWorkspaceId)
  const setActiveWorkspace = useBrowserStore((state) => state.setActiveWorkspace)
  const createWorkspace = useBrowserStore((state) => state.createWorkspace)
  const updateWorkspaceAppearance = useBrowserStore((state) => state.updateWorkspaceAppearance)
  const deleteWorkspace = useBrowserStore((state) => state.deleteWorkspace)
  const accentColor = useBrowserStore((state) => state.settings.accentColor)
  const animations = useBrowserStore((state) => state.settings.animations)
  const privateWorkspaceDefault = useBrowserStore((state) => state.settings.privacy.privateWorkspaceDefault)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const [appearanceWorkspaceId, setAppearanceWorkspaceId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // Rows leaving on collapse stay mounted, out of flow, until they fade out.
  const [exiting, setExiting] = useState<Array<{ id: string; box: RowBox }>>([])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const transitionRef = useRef<Transition | null>(null)
  const runningRef = useRef<Animation[]>([])

  const ordered = workspaces.slice().sort((a, b) => a.order - b.order)
  const activeWorkspace = ordered.find((workspace) => workspace.id === activeWorkspaceId) ?? ordered[0]
  const visible = collapsed && activeWorkspace ? [activeWorkspace] : ordered

  const setRowRef = (id: string) => (element: HTMLElement | null): void => {
    if (element) rowRefs.current.set(id, element)
    else rowRefs.current.delete(id)
  }

  const snapshot = (kind: Transition['kind']): Transition | null => {
    const root = rootRef.current
    if (!root || !motionAllowed(animations)) return null
    const rootRect = root.getBoundingClientRect()
    const boxes = new Map<string, RowBox>()
    for (const [id, element] of rowRefs.current) {
      const rect = element.getBoundingClientRect()
      boxes.set(id, { top: rect.top - rootRect.top, left: rect.left - rootRect.left, width: rect.width, height: rect.height })
    }
    return { kind, boxes, rootHeight: rootRect.height }
  }

  const toggleCollapsed = (): void => {
    if (runningRef.current.length > 0) return
    const next = !collapsed
    transitionRef.current = snapshot(next ? 'collapse' : 'expand')
    if (next) {
      setAppearanceWorkspaceId((current) => (current === activeWorkspace?.id ? current : null))
      const leaving = transitionRef.current
        ? [...transitionRef.current.boxes].filter(([id]) => id !== activeWorkspace?.id).map(([id, box]) => ({ id, box }))
        : []
      setExiting(leaving)
    }
    setCollapsed(next)
    writeCollapsed(next)
  }

  useLayoutEffect(() => {
    const transition = transitionRef.current
    const root = rootRef.current
    transitionRef.current = null
    if (!transition || !root) return
    const rootRect = root.getBoundingClientRect()
    const started: Animation[] = []
    const run = (element: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): void => {
      if (element) started.push(element.animate(keyframes, options))
    }

    // Every row still in flow slides from its previous position.
    for (const [id, element] of rowRefs.current) {
      if (exiting.some((row) => row.id === id)) continue
      const before = transition.boxes.get(id)
      const top = element.getBoundingClientRect().top - rootRect.top
      if (before) {
        const dy = before.top - top
        if (Math.abs(dy) > 0.5) run(element, [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: MOVE_MS, easing: EASE })
      } else {
        // Revealed on expand: fade in with a slight settle, after the move starts.
        run(element, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: FADE_IN_MS, delay: 60, easing: EASE, fill: 'backwards' })
      }
    }

    // Rows leaving fade out from where they were.
    for (const row of exiting) {
      run(rowRefs.current.get(row.id), [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.98)' }], { duration: FADE_OUT_MS, easing: 'ease-out', fill: 'forwards' })
    }

    // Content below (the tab list) glides into or out of the freed space. It is
    // clipped by its own scroll container, so it never overlaps the footer.
    const shift = transition.rootHeight - rootRect.height
    if (Math.abs(shift) > 0.5) run(followRef?.current, [{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], { duration: MOVE_MS, easing: EASE })

    runningRef.current = started
    let cancelled = false
    void Promise.allSettled(started.map((animation) => animation.finished)).then(() => {
      if (cancelled) return
      runningRef.current = []
      if (transition.kind === 'collapse') setExiting([])
    })
    return () => {
      cancelled = true
    }
  }, [collapsed])

  useLayoutEffect(() => () => {
    for (const animation of runningRef.current) animation.cancel()
  }, [])

  const renderRow = (workspace: (typeof ordered)[number], ghost?: RowBox): JSX.Element => {
    const active = workspace.id === activeWorkspace?.id
    return (
      <div
        key={workspace.id}
        ref={setRowRef(workspace.id)}
        className={ghost ? 'pointer-events-none absolute' : 'relative'}
        style={ghost ? { top: ghost.top, left: ghost.left, width: ghost.width, height: ghost.height } : active ? { zIndex: 1 } : undefined}
        aria-hidden={ghost ? true : undefined}
        data-workspace-id={ghost ? undefined : workspace.id}
        data-workspace-icon={workspace.icon}
        data-workspace-color={workspace.color}
      >
        <div
          className={`group/workspace flex h-10 w-full items-center gap-1 rounded-control border px-2 transition duration-150 ${
            active
              ? 'border-white/12 bg-white/11 text-white'
              : 'border-transparent text-vast-soft hover:border-white/8 hover:bg-white/6 hover:text-white'
          } ${compact ? `sidebar-tile justify-center px-0 ${active ? 'is-active' : ''}` : ''}`}
        >
          <button
            type="button"
            tabIndex={ghost ? -1 : undefined}
            onClick={() => (active ? toggleCollapsed() : setActiveWorkspace(workspace.id))}
            title={active ? `${workspace.name} · ${collapsed ? 'Show all workspaces' : 'Hide other workspaces'}` : workspace.name}
            aria-expanded={active ? !collapsed : undefined}
            className={`flex min-w-0 flex-1 items-center gap-3 text-left ${compact ? 'justify-center' : ''}`}
          >
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-control"
              style={{ backgroundColor: `${workspace.color}22`, color: workspace.color }}
            >
              <WorkspaceIcon name={workspace.icon} className="h-3.5 w-3.5" />
            </span>
            {!compact && <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{workspace.name}</span>}
          </button>
          {!compact && !ghost && (
            <>
              <button
                type="button"
                title={`Customize ${workspace.name} workspace`}
                aria-expanded={appearanceWorkspaceId === workspace.id}
                onClick={(event) => {
                  event.stopPropagation()
                  setAppearanceWorkspaceId((current) => current === workspace.id ? null : workspace.id)
                }}
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-control transition hover:bg-white/8 hover:text-white ${
                  appearanceWorkspaceId === workspace.id ? 'bg-white/10 text-white opacity-100' : 'text-vast-soft opacity-0 group-hover/workspace:opacity-100'
                }`}
              >
                <Palette className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Delete workspace"
                disabled={workspaces.length <= 1}
                onClick={(event) => {
                  event.stopPropagation()
                  if (workspaces.length <= 1) return
                  openPromptDialog({
                    title: `Delete "${workspace.name}" workspace?`,
                    description: 'Tabs, groups, notes, and reading-list items in this workspace will be removed.',
                    label: '', hideInput: true, allowEmpty: true, confirmLabel: 'Delete workspace',
                    onConfirm: () => deleteWorkspace(workspace.id)
                  })
                }}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-vast-soft opacity-0 transition hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-20 group-hover/workspace:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
        {!compact && !ghost && appearanceWorkspaceId === workspace.id && (
          <div className="absolute left-0 right-0 top-11 z-50">
            <WorkspaceAppearancePicker
              compact
              workspaceId={workspace.id}
              icon={workspace.icon}
              color={workspace.color}
              onChange={(patch) => updateWorkspaceAppearance(workspace.id, patch)}
            />
          </div>
        )}
      </div>
    )
  }

  const renderNewWorkspace = (ghost?: RowBox): JSX.Element => (
    <button
      key={NEW_WORKSPACE_ROW}
      ref={setRowRef(NEW_WORKSPACE_ROW)}
      type="button"
      tabIndex={ghost ? -1 : undefined}
      aria-hidden={ghost ? true : undefined}
      style={ghost ? { top: ghost.top, left: ghost.left, width: ghost.width, height: ghost.height } : undefined}
      onClick={() =>
        openPromptDialog({
          title: 'New workspace',
          label: 'Workspace name',
          placeholder: 'Research, Travel, Side project',
          confirmLabel: 'Create workspace',
          onConfirm: (name) => createWorkspace(name, accentColor, privateWorkspaceDefault)
        })
      }
      title="New workspace"
      className={`flex h-10 w-full items-center gap-3 rounded-control border px-3 text-left transition ${ghost ? 'pointer-events-none absolute' : ''} ${
        compact
          ? 'sidebar-tile justify-center px-0'
          : 'border-dashed border-white/10 text-vast-soft hover:border-white/18 hover:bg-white/5.5 hover:text-white'
      }`}
    >
      <Plus className="h-4 w-4" />
      {!compact && <span className="text-[13px] font-medium">New workspace</span>}
    </button>
  )

  return (
    <div ref={rootRef} className="relative space-y-1" data-collapsed={collapsed || undefined}>
      {/* Leaving rows first: Tailwind's space-y spaces every child but the last,
          so the in-flow rows keep their spacing while the others fade out. */}
      {exiting.map(({ id, box }) => {
        if (id === NEW_WORKSPACE_ROW) return renderNewWorkspace(box)
        const workspace = ordered.find((item) => item.id === id)
        return workspace ? renderRow(workspace, box) : null
      })}
      {visible.map((workspace) => renderRow(workspace))}
      {!collapsed && renderNewWorkspace()}
    </div>
  )
}
