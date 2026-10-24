import type { DocumentSpoofingConfig } from '../shared/spoofing'
import type { GuestDocumentStartResponse } from '../shared/guest-document-start'

const MAX_REQUESTED_URL_LENGTH = 32_768

export interface GuestDocumentStartDependencies<Contents, Frame> {
  /** True when the guest is hosted by a live Vast browser window. */
  trustedHost: (contents: Contents) => boolean
  spoofingConfig: (contents: Contents, url: string) => DocumentSpoofingConfig | null
  privacyScript: (contents: Contents, url: string) => string
  /** Site permissions still set to Ask, which the page should read as "prompt". */
  undecidedPermissions: (contents: Contents, url: string) => string[]
  documentRulesAllowed: (contents: Contents, url: string) => boolean
  /** Consumes the rules staged for this navigation; checks frame and URL itself. */
  takeDocumentRules: (contents: Contents, url: string, frame: Frame) => string[]
}

/**
 * Builds the single synchronous document-start reply for the guest preload.
 * It performs exactly what the three former channels did, in the same order
 * (spoofing, privacy, extension document rules) and with the same checks, so
 * merging them only removes two blocking round trips per document. A failure
 * in one part yields that part's empty value and never blocks navigation.
 */
export function guestDocumentStartResponse<Contents, Frame>(
  contents: Contents,
  frame: Frame,
  request: unknown,
  dependencies: GuestDocumentStartDependencies<Contents, Frame>
): GuestDocumentStartResponse {
  const response: GuestDocumentStartResponse = { spoofing: null, privacyScript: '', undecidedPermissions: [], documentRules: [] }
  if (!request || typeof request !== 'object') return response
  const { url, documentRules } = request as { url?: unknown; documentRules?: unknown }
  if (typeof url !== 'string') return response

  let trusted = false
  try {
    trusted = url.length <= MAX_REQUESTED_URL_LENGTH && dependencies.trustedHost(contents)
  } catch { /* An unreadable host is untrusted. */ }
  if (trusted) {
    try {
      response.spoofing = dependencies.spoofingConfig(contents, url)
    } catch { /* Network headers stay coherent without the JS surface. */ }
    try {
      const script = dependencies.privacyScript(contents, url)
      response.privacyScript = typeof script === 'string' ? script : ''
    } catch { /* Fall back to no document script. */ }
    try {
      const names = dependencies.undecidedPermissions(contents, url)
      response.undecidedPermissions = Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
    } catch { /* Pages keep the native "denied" reading. */ }
  }

  if (documentRules === true) {
    try {
      if (dependencies.documentRulesAllowed(contents, url)) {
        const rules = dependencies.takeDocumentRules(contents, url, frame)
        response.documentRules = Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === 'string') : []
      }
    } catch { /* Unavailable document rules must never prevent navigation. */ }
  }
  return response
}
