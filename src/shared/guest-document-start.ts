import type { DocumentSpoofingConfig } from './spoofing'

export const GUEST_DOCUMENT_START_CHANNEL = 'vast:guest:document-start'

/** What the guest preload asks for once, synchronously, before page scripts run. */
export interface GuestDocumentStartRequest {
  url: string
  /** Main frame of an http(s) document; only then are extension document rules consumed. */
  documentRules: boolean
}

/** Everything the guest preload applies at document start, in application order. */
export interface GuestDocumentStartResponse {
  spoofing: DocumentSpoofingConfig | null
  privacyScript: string
  /** Camera, microphone, location or notifications still set to Ask for this site. */
  undecidedPermissions: string[]
  documentRules: string[]
}
