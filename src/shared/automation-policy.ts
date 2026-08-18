import { INTERNAL_PASSWORDS_URL } from './constants.ts'
import { isAuthSensitiveUrl } from './auth-compatibility-policy.ts'
import type { MacroAction } from './types'

const SENSITIVE_PATH = /(?:^|\/)(?:billing|checkout|pay|payment|payments|purchase|wallet|vault)(?:\/|$)/i

export function isSensitiveAutomationUrl(input: string): boolean {
  if (!input) return false
  if (input === INTERNAL_PASSWORDS_URL || input.startsWith(`${INTERNAL_PASSWORDS_URL}?`)) return true
  if (isAuthSensitiveUrl(input)) return true
  try {
    const parsed = new URL(input)
    return SENSITIVE_PATH.test(parsed.pathname)
  } catch {
    return false
  }
}

export function macroActionUrl(action: MacroAction): string | undefined {
  if (action.type === 'open-internal-page') return action.internalUrl
  if (action.type === 'open-url-current' || action.type === 'open-url-new-tab') return action.url
  return undefined
}

export function macroPermissionSummary(actions: MacroAction[]): string[] {
  const permissions = new Set<string>()
  for (const action of actions) {
    if (action.type.startsWith('open-url') || action.type === 'open-multiple-urls' || action.type === 'open-internal-page') permissions.add('Open pages and tabs')
    if (action.type === 'switch-workspace' || action.type === 'create-workspace') permissions.add('Change workspaces')
    if (action.type === 'create-note' || action.type === 'append-note') permissions.add('Write notes')
    if (action.type === 'close-duplicate-tabs' || action.type === 'hibernate-inactive-tabs') permissions.add('Change existing tabs')
    if (action.type === 'save-session-snapshot' || action.type === 'save-reading-list') permissions.add('Write browser data')
    if (action.type === 'open-side-panel' || action.type === 'toggle-focus-mode' || action.type === 'run-command') permissions.add('Change Vast interface')
  }
  return [...permissions]
}

export function macroContainsSensitiveTarget(actions: MacroAction[]): boolean {
  return actions.some((action) => {
    const direct = macroActionUrl(action)
    if (direct && isSensitiveAutomationUrl(direct)) return true
    return action.type === 'open-multiple-urls' && (action.urls ?? []).some(isSensitiveAutomationUrl)
  })
}
