import type { ID } from '../../shared/types'

const pendingRequestByTab = new Map<ID, string>()

export function setPendingExtensionCompatibilityTab(tabId: ID, requestId: string | undefined): void {
  if (requestId) pendingRequestByTab.set(tabId, requestId)
}

export function pendingExtensionCompatibilityTab(tabId: ID): string | undefined {
  return pendingRequestByTab.get(tabId)
}

export function completePendingExtensionCompatibilityTab(tabId: ID, requestId: string): void {
  if (pendingRequestByTab.get(tabId) === requestId) pendingRequestByTab.delete(tabId)
}
