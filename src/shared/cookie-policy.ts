import { shouldBypassVastInterference } from './auth-compatibility-policy.ts'
import { hostMatchesList, isThirdPartyUrl } from './url-cleaning.ts'

export interface ThirdPartyCookieContext {
  requestUrl: string
  topLevelUrl?: string
  resourceType: string
  enabled: boolean
  exceptions: readonly string[]
  authWindow?: boolean
}

export function shouldBlockThirdPartyCookieHeaders(context: ThirdPartyCookieContext): boolean {
  if (!context.enabled || context.resourceType === 'mainFrame') return false
  if (shouldBypassVastInterference({
    url: context.requestUrl,
    topLevelUrl: context.topLevelUrl,
    authWindow: context.authWindow
  })) return false
  if (!context.topLevelUrl || !isThirdPartyUrl(context.requestUrl, context.topLevelUrl)) return false
  if (
    hostMatchesList(context.topLevelUrl, context.exceptions) ||
    hostMatchesList(context.requestUrl, context.exceptions)
  ) return false
  return true
}
