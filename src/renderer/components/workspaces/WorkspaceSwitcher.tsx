import { Palette, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useBrowserStore } from '../../store/browser-store'
import { WorkspaceAppearancePicker } from './WorkspaceAppearancePicker'
import { WorkspaceIcon } from './WorkspaceIcon'

export function WorkspaceSwitcher({ compact }: { compact?: boolean }): JSX.Element {
  const workspaces = useBrowserStore((state) => state.workspaces)
  const activeWorkspaceId = useBrowserStore((state) => state.activeWorkspaceId)
  const setActiveWorkspace = useBrowserStore((state) => state.setActiveWorkspace)
  const createWorkspace = useBrowserStore((state) => state.createWorkspace)
  const updateWorkspaceAppearance = useBrowserStore((state) => state.updateWorkspaceAppearance)
  const deleteWorkspace = useBrowserStore((state) => state.deleteWorkspace)
  const accentColor = useBrowserStore((state) => state.settings.accentColor)
  const privateWorkspaceDefault = useBrowserStore((state) => state.settings.privacy.privateWorkspaceDefault)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const [appearanceWorkspaceId, setAppearanceWorkspaceId] = useState<string | null>(null)

  return (
    <div className={compact ? 'space-y-2' : 'space-y-1'}>
      {workspaces
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((workspace) => {
          const active = workspace.id === activeWorkspaceId
          return (
            <div
              key={workspace.id}
              className="relative"
              data-workspace-id={workspace.id}
              data-workspace-icon={workspace.icon}
              data-workspace-color={workspace.color}
            >
              <div
                className={`group/workspace flex h-10 w-full items-center gap-1 rounded-xl border px-2 transition duration-150 ${
                  active
                    ? 'border-white/[0.12] bg-white/[0.11] text-white shadow-glow'
                    : 'border-transparent text-vast-soft hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-white'
                } ${compact ? 'justify-center px-0' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => setActiveWorkspace(workspace.id)}
                  title={workspace.name}
                  className={`flex min-w-0 flex-1 items-center gap-3 text-left ${compact ? 'justify-center' : ''}`}
                >
                  <span
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-lg"
                    style={{ backgroundColor: `${workspace.color}22`, color: workspace.color }}
                  >
                    <WorkspaceIcon name={workspace.icon} className="h-3.5 w-3.5" />
                  </span>
                  {!compact && <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{workspace.name}</span>}
                </button>
                {!compact && (
                  <>
                    <button
                      type="button"
                      title={`Customize ${workspace.name} workspace`}
                      aria-expanded={appearanceWorkspaceId === workspace.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        setAppearanceWorkspaceId((current) => current === workspace.id ? null : workspace.id)
                      }}
                      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg transition hover:bg-white/[0.08] hover:text-white ${
                        appearanceWorkspaceId === workspace.id ? 'bg-white/[0.1] text-white opacity-100' : 'text-vast-soft opacity-0 group-hover/workspace:opacity-100'
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
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-vast-soft opacity-0 transition hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-20 group-hover/workspace:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              {!compact && appearanceWorkspaceId === workspace.id && (
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
        })}
      <button
        type="button"
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
        className={`flex h-10 w-full items-center gap-3 rounded-xl border px-3 text-left transition ${
          compact
            ? 'justify-center border-transparent bg-transparent px-0 text-white/20 hover:bg-white/[0.05] hover:text-white/50'
            : 'border-dashed border-white/10 text-vast-soft hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-white'
        }`}
      >
        <Plus className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        {!compact && <span className="text-[13px] font-medium">New workspace</span>}
      </button>
    </div>
  )
}
