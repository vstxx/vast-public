import { Copy, GripVertical, Play, Plus, Search, ShieldAlert, Sparkles, Square, TestTube2, Trash2 } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { MacroAction, MacroActionType, MacroTriggerType } from '../../../shared/types'
import { INTERNAL_AUTOMATION_URL, INTERNAL_DIAGNOSTICS_URL, INTERNAL_NEW_TAB_URL, INTERNAL_NOTES_URL, INTERNAL_SESSION_TIMELINE_URL } from '../../../shared/constants'
import { isSensitiveAutomationUrl, macroContainsSensitiveTarget, macroPermissionSummary } from '../../../shared/automation-policy'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatRelativeTime } from '../../lib/format'
import { createId } from '../../lib/id'
import { useBrowserStore } from '../../store/browser-store'
import { VastSelect } from '../ui/VastSelect'
import { selectActiveTab } from '../../store/browser-store'
import { useVastConfirm } from '../ui/useVastConfirm'

const actionTypes: Array<{ value: MacroActionType; label: string }> = [
  { value: 'open-url-new-tab', label: 'Open URL in new tab' },
  { value: 'open-internal-page', label: 'Open internal page' },
  { value: 'switch-workspace', label: 'Switch workspace' },
  { value: 'create-note', label: 'Create note' },
  { value: 'open-side-panel', label: 'Open sidebar' },
  { value: 'save-session-snapshot', label: 'Save session snapshot' },
  { value: 'close-duplicate-tabs', label: 'Close duplicate tabs' },
  { value: 'hibernate-inactive-tabs', label: 'Hibernate inactive tabs' },
  { value: 'toggle-focus-mode', label: 'Toggle focus mode' }
]

const triggerOptions: Array<{ value: MacroTriggerType; label: string }> = [
  { value: 'manual', label: 'Manual only' },
  { value: 'command-palette', label: 'Command palette' },
  { value: 'startup', label: 'Startup (not active in safe mode)' },
  { value: 'workspace-opened', label: 'Workspace opened (not active in safe mode)' },
  { value: 'new-tab-opened', label: 'New tab opened (not active in safe mode)' },
  { value: 'time', label: 'Timed (not active in safe mode)' }
]

function AutomationSelect<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className="settings-select-label grid content-start gap-2 text-sm font-semibold">
      <span className="leading-5">{label}</span>
      <VastSelect
        value={value}
        options={options}
        onChange={onChange}
        ariaLabel={label}
        className="settings-select-control !w-full !min-w-0"
        buttonClassName="h-11"
        dataSettingsSelect={label}
      />
    </div>
  )
}

function defaultAction(type: MacroActionType = 'open-url-new-tab'): MacroAction {
  return {
    id: createId('action'),
    type,
    url: type === 'open-url-new-tab' ? 'https://github.com' : undefined,
    internalUrl: type === 'open-internal-page' ? INTERNAL_NOTES_URL : undefined,
    noteTitle: type === 'create-note' ? 'Automation note' : undefined,
    noteBody: type === 'create-note' ? 'Created by a Vast macro.' : undefined,
    sidePanelView: type === 'open-side-panel' ? 'notes' : undefined
  }
}

export function AutomationPage(): JSX.Element {
  const confirm = useVastConfirm()
  const runtime = useBrowserRuntime()
  const macros = useBrowserStore((state) => state.macros)
  const logs = useBrowserStore((state) => state.macroLogs)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const createMacro = useBrowserStore((state) => state.createMacro)
  const updateMacro = useBrowserStore((state) => state.updateMacro)
  const deleteMacro = useBrowserStore((state) => state.deleteMacro)
  const duplicateMacro = useBrowserStore((state) => state.duplicateMacro)
  const activeTab = useBrowserStore(selectActiveTab)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(macros[0]?.id ?? '')
  const [runningId, setRunningId] = useState<string | null>(null)
  const [dragActionId, setDragActionId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)

  const filtered = useMemo(() => {
    const needle = deferredQuery.toLowerCase().trim()
    return macros.filter((macro) => !needle || `${macro.name} ${macro.description}`.toLowerCase().includes(needle))
  }, [deferredQuery, macros])
  const selected = macros.find((macro) => macro.id === selectedId) ?? filtered[0]

  const addMacro = (): void => {
    const macro = createMacro({
      name: 'New Macro',
      description: 'Manual Vast automation.',
      icon: 'Sparkles',
      color: '#74e7ff',
      trigger: 'manual',
      actions: [defaultAction()]
    })
    setSelectedId(macro.id)
  }

  const updateAction = (actionId: string, patch: Partial<MacroAction>): void => {
    if (!selected) return
    updateMacro(selected.id, {
      actions: selected.actions.map((action) => (action.id === actionId ? { ...action, ...patch } : action))
    })
  }

  const removeAction = (actionId: string): void => {
    if (!selected) return
    updateMacro(selected.id, { actions: selected.actions.filter((action) => action.id !== actionId) })
  }

  const moveAction = (sourceId: string, targetId: string): void => {
    if (!selected || sourceId === targetId) return
    const actions = [...selected.actions]
    const sourceIndex = actions.findIndex((action) => action.id === sourceId)
    const targetIndex = actions.findIndex((action) => action.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [moved] = actions.splice(sourceIndex, 1)
    actions.splice(targetIndex, 0, moved)
    updateMacro(selected.id, { actions })
  }

  const runMacro = async (dryRun = false): Promise<void> => {
    if (!selected || runningId) return
    if (selected.actions.length > 25) {
      setStatusMessage('This macro exceeds the 25-action safety limit.')
      return
    }
    const permissions = macroPermissionSummary(selected.actions)
    const sensitive = isSensitiveAutomationUrl(activeTab?.url ?? '') || macroContainsSensitiveTarget(selected.actions)
    if (!dryRun) {
      const approved = await confirm(
        sensitive ? 'Run macro on sensitive content?' : `Run “${selected.name}”?`,
        `${permissions.join(', ') || 'No persistent changes'}. Maximum 25 actions and 30 seconds.${sensitive ? ' This touches authentication, payment, or vault content and needs this one-time approval.' : ''}`,
        sensitive ? 'Approve and run' : 'Run macro'
      )
      if (!approved) return
    }
    setRunningId(selected.id)
    const result = await runtime.runMacro(selected.id, { dryRun, allowSensitive: dryRun || sensitive })
    setRunningId(null)
    setStatusMessage(result.message)
  }

  return (
    <div className="labs-page-surface h-full overflow-y-auto overflow-x-hidden bg-[#06070a] p-6 text-white" data-testid="automation-page">
      <div className="mx-auto grid max-w-7xl gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="vast-glass-panel rounded-[30px] p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h1 className="text-3xl font-semibold">Automation</h1>
            <button type="button" onClick={addMacro} className="grid h-11 w-11 place-items-center rounded-2xl bg-vast-cyan text-black" title="Create macro">
              <Plus className="h-5 w-5" />
            </button>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search macros" className="h-11 w-full rounded-2xl border border-white/10 bg-black/20 pl-10 pr-3 text-sm text-white outline-none focus:border-vast-cyan/[0.35]" />
          </div>
          <div className="space-y-2">
            {filtered.map((macro) => (
              <button key={macro.id} type="button" onClick={() => setSelectedId(macro.id)} className={`w-full rounded-2xl p-3 text-left transition ${selected?.id === macro.id ? 'bg-white/[0.1]' : 'hover:bg-white/[0.055]'}`}>
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-2xl" style={{ backgroundColor: `${macro.color}22`, color: macro.color }}>
                    <Sparkles className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{macro.name}</div>
                    <div className="truncate text-xs text-vast-soft">{macro.actions.length} actions - {macro.trigger}</div>
                  </div>
                  <span className={`h-2.5 w-2.5 rounded-full ${macro.enabled ? 'bg-emerald-300' : 'bg-white/25'}`} />
                </div>
              </button>
            ))}
            {filtered.length === 0 && <div className="rounded-3xl border border-dashed border-white/10 p-8 text-center text-sm text-vast-soft">No macros match this search.</div>}
          </div>
        </section>

        <section className="vast-glass-panel min-h-[720px] rounded-[30px] p-5">
          {selected ? (
            <div className="space-y-5">
              <div className="border-b border-white/10 pb-5">
                <div className="grid min-w-0 gap-3">
                  <input value={selected.name} onChange={(event) => updateMacro(selected.id, { name: event.target.value })} className="bg-transparent text-3xl font-semibold text-white outline-none" data-testid="macro-name-input" />
                  <textarea value={selected.description} onChange={(event) => updateMacro(selected.id, { description: event.target.value })} rows={2} className="resize-none rounded-2xl border border-white/10 bg-black/20 p-3 text-sm leading-6 text-vast-soft outline-none focus:border-vast-cyan/[0.35]" />
                </div>
                <div className="mt-3 grid grid-cols-4 gap-2" data-testid="automation-primary-actions">
                  <button type="button" onClick={() => void runMacro(false)} disabled={Boolean(runningId)} className="vault-action-button min-w-0 justify-center bg-vast-cyan px-2 text-black disabled:opacity-50" data-testid="macro-run-button"><Play className="h-4 w-4" />{runningId ? 'Running…' : 'Run'}</button>
                  <button type="button" onClick={() => void runMacro(true)} disabled={Boolean(runningId)} className="vault-action-button min-w-0 justify-center px-2 disabled:opacity-50"><TestTube2 className="h-4 w-4" />Dry run</button>
                  <button type="button" onClick={() => duplicateMacro(selected.id)} className="vault-action-button min-w-0 justify-center px-2"><Copy className="h-4 w-4" />Duplicate</button>
                  <button type="button" onClick={() => deleteMacro(selected.id)} className="vault-danger-button min-w-0 justify-center px-2"><Trash2 className="h-4 w-4" />Delete</button>
                </div>
                {runningId === selected.id && <button type="button" onClick={() => runtime.stopMacro(selected.id)} className="vault-danger-button mt-2 w-full justify-center"><Square className="h-4 w-4" />Emergency stop</button>}
              </div>

              <div className="rounded-2xl border border-vast-amber/20 bg-vast-amber/[0.06] p-4">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-vast-amber" />
                  <div>
                    <div className="text-sm font-semibold">Permission preview</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {macroPermissionSummary(selected.actions).map((permission) => <span key={permission} className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-xs text-vast-soft">{permission}</span>)}
                      {macroPermissionSummary(selected.actions).length === 0 && <span className="text-xs text-vast-soft">No persistent changes.</span>}
                    </div>
                    <div className="mt-2 text-xs leading-5 text-vast-soft">Authentication, payment and password-vault pages are blocked unless you approve that exact manual run. Every run is limited to 25 actions and 30 seconds.</div>
                  </div>
                </div>
              </div>
              {statusMessage && <div className="rounded-2xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm text-vast-soft">{statusMessage}</div>}

              <div className="grid items-end gap-3 md:grid-cols-3">
                <AutomationSelect
                  label="Trigger"
                  value={selected.trigger}
                  options={triggerOptions}
                  onChange={(trigger) => updateMacro(selected.id, { trigger })}
                />
                <label className="grid content-start gap-2 text-sm font-semibold">
                  <span className="leading-5">Color</span>
                  <span className="flex h-11 items-center rounded-2xl border border-white/10 bg-white/[0.045] px-3">
                    <input className="h-7 w-full cursor-pointer rounded-lg bg-transparent" type="color" value={selected.color} onChange={(event) => updateMacro(selected.id, { color: event.target.value })} />
                  </span>
                </label>
                <label className="grid content-start gap-2 text-sm font-semibold">
                  <span className="leading-5">Enabled</span>
                  <span className="flex h-11 items-center justify-between rounded-2xl border border-white/10 bg-white/[0.045] px-4">
                    <span className="text-xs font-medium text-vast-soft">Macro active</span>
                    <input type="checkbox" checked={selected.enabled} onChange={(event) => updateMacro(selected.id, { enabled: event.target.checked })} />
                  </span>
                </label>
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Actions</h2>
                  <button type="button" onClick={() => updateMacro(selected.id, { actions: [...selected.actions, defaultAction()] })} className="settings-action settings-action-compact"><Plus className="h-4 w-4" />Add action</button>
                </div>
                <div className="space-y-3">
                  {selected.actions.map((action, index) => (
                    <div
                      key={action.id}
                      draggable
                      onDragStart={() => setDragActionId(action.id)}
                      onDragEnd={() => setDragActionId(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => {
                        if (dragActionId) moveAction(dragActionId, action.id)
                        setDragActionId(null)
                      }}
                      className={`rounded-3xl border bg-black/[0.18] p-4 transition ${dragActionId === action.id ? 'border-vast-cyan/40 opacity-60' : 'border-white/10'}`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex cursor-grab items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-vast-soft"><GripVertical className="h-4 w-4" />Step {index + 1}</div>
                        <button type="button" onClick={() => removeAction(action.id)} className="text-xs text-vast-soft hover:text-white">Remove</button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <AutomationSelect
                          label="Action"
                          value={action.type}
                          options={actionTypes}
                          onChange={(type) => updateAction(action.id, defaultAction(type))}
                        />
                        {(action.type === 'open-url-new-tab' || action.type === 'open-url-current') && (
                          <label>
                            <span>URL</span>
                            <input value={action.url ?? ''} onChange={(event) => updateAction(action.id, { url: event.target.value })} placeholder="https://example.com" />
                          </label>
                        )}
                        {action.type === 'open-internal-page' && (
                          <AutomationSelect
                            label="Internal page"
                            value={action.internalUrl ?? INTERNAL_NEW_TAB_URL}
                            options={[
                              { value: INTERNAL_NEW_TAB_URL, label: 'New tab' },
                              { value: INTERNAL_NOTES_URL, label: 'Notes' },
                              { value: INTERNAL_AUTOMATION_URL, label: 'Automation' },
                              { value: INTERNAL_DIAGNOSTICS_URL, label: 'Diagnostics' },
                              { value: INTERNAL_SESSION_TIMELINE_URL, label: 'Session Timeline' }
                            ]}
                            onChange={(internalUrl) => updateAction(action.id, { internalUrl })}
                          />
                        )}
                        {action.type === 'switch-workspace' && (
                          <AutomationSelect
                            label="Workspace"
                            value={action.workspaceId ?? ''}
                            options={[
                              { value: '', label: 'Choose workspace' },
                              ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))
                            ]}
                            onChange={(workspaceId) => updateAction(action.id, { workspaceId })}
                          />
                        )}
                        {action.type === 'create-note' && (
                          <>
                            <label><span>Note title</span><input value={action.noteTitle ?? ''} onChange={(event) => updateAction(action.id, { noteTitle: event.target.value })} /></label>
                            <label><span>Note body</span><input value={action.noteBody ?? ''} onChange={(event) => updateAction(action.id, { noteBody: event.target.value })} /></label>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="mb-3 text-lg font-semibold">Activity</h2>
                <div className="space-y-2">
                  {logs.filter((log) => log.macroId === selected.id).slice(0, 8).map((log) => (
                    <div key={log.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3 text-sm">
                      <div className="flex justify-between gap-3"><span className={log.status === 'success' ? 'text-emerald-300' : 'text-vast-amber'}>{log.status}</span><span className="text-xs text-vast-soft">{formatRelativeTime(log.ranAt)}</span></div>
                      <div className="mt-1 text-vast-soft">{log.message}</div>
                    </div>
                  ))}
                  {!logs.some((log) => log.macroId === selected.id) && <div className="rounded-2xl border border-dashed border-white/10 p-5 text-sm text-vast-soft">Run this macro to see local activity here.</div>}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-center">
              <div><Sparkles className="mx-auto mb-4 h-10 w-10 text-vast-cyan" /><div className="text-xl font-semibold">No macros yet</div><button type="button" onClick={addMacro} className="mt-4 rounded-2xl bg-vast-cyan px-4 py-2 text-sm font-semibold text-black">Create macro</button></div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
