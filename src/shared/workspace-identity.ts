import { VAST_DEFAULT_WEBVIEW_PARTITION } from './oauth.ts'
import type { Workspace, WorkspaceIdentitySettings } from './types'

export const DEFAULT_WORKSPACE_IDENTITY: WorkspaceIdentitySettings = {
  sessionMode: 'isolated',
  proxyMode: 'system',
  proxyServer: '',
  proxyBypassRules: '<local>'
}

export function resolveWorkspaceIdentity(workspace: Pick<Workspace, 'id' | 'isPrivate' | 'identity'>): WorkspaceIdentitySettings {
  return {
    ...DEFAULT_WORKSPACE_IDENTITY,
    ...(workspace.isPrivate ? { sessionMode: 'ephemeral' as const } : undefined),
    ...workspace.identity
  }
}

function safePartitionId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80) || 'workspace'
}

export function partitionForWorkspace(workspace: Pick<Workspace, 'id' | 'isPrivate' | 'identity'>): string {
  const identity = resolveWorkspaceIdentity(workspace)
  if (identity.sessionMode === 'shared') return VAST_DEFAULT_WEBVIEW_PARTITION
  const id = safePartitionId(workspace.id)
  return identity.sessionMode === 'ephemeral' ? `vast-workspace-${id}` : `persist:vast-workspace-${id}`
}
