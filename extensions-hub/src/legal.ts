import { HttpError, sha256 } from './security.ts'

export const PUBLISHER_TERMS_VERSION = '2026-08-24'
export const PUBLISHER_WARRANTY_VERSION = '2026-08-24'

export interface HubLegalConfig {
  operatorName: string
  contactUrl: string
}

const LEGAL_PLACEHOLDER = /(?:\bTODO\b|CHANGE[_ -]?ME|\bUNKNOWN\b|\bTBD\b|EXAMPLE(?:\.COM)?)/i

function isProduction(env: Env): boolean {
  return String(env.ENVIRONMENT ?? '').trim().toLowerCase() === 'production'
}

export function optionalLegalConfig(env: Env): HubLegalConfig | undefined {
  const operatorName = String(env.HUB_LEGAL_OPERATOR_NAME ?? '').trim()
  const contact = String(env.HUB_LEGAL_CONTACT_URL ?? '').trim()
  if (operatorName.length < 2 || operatorName.length > 200 || LEGAL_PLACEHOLDER.test(operatorName)) return undefined
  if (!contact || contact.length > 2048 || LEGAL_PLACEHOLDER.test(contact)) return undefined
  try {
    const url = new URL(contact)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return undefined
    if (isProduction(env) && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()))) return undefined
    return { operatorName, contactUrl: url.toString() }
  } catch { return undefined }
}

export function requireLegalConfig(env: Env): HubLegalConfig {
  const config = optionalLegalConfig(env)
  if (!config) throw new HttpError(503, 'Publishing is unavailable until the verified platform operator and legal contact are configured.')
  return config
}

export function publisherTermsText(operatorName: string): string {
  return [
    `Vast Extensions Hub Publisher Terms ${PUBLISHER_TERMS_VERSION}`,
    `Operator: ${operatorName}`,
    'The publisher retains ownership of its extension and submitted materials.',
    'By submitting materials, the publisher grants the operator a worldwide, non-exclusive, royalty-free, fully paid-up, transferable and sublicensable license, only as needed to operate or transfer the Vast extension ecosystem, to host, store, reproduce, cache, scan, analyze, test, validate, review, security-scan, malware-scan, repackage, cryptographically sign, distribute, redistribute, make available, deliver updates, display listing materials, create technical previews, promote the listing inside Vast, perform compatibility transformations necessary for operation or security, and retain archival, security and audit copies.',
    'The license permits Vast users to download, install, execute and update published releases. Rights reasonably required for copies already distributed, existing installations, security response, updates and migrations, backups, audit records, fraud and abuse prevention, and legal compliance survive delisting or account closure to the extent permitted by applicable law.',
    'The publisher represents that it owns or has all rights required for the extension, libraries, assets, icons, screenshots and listing text; that requested permissions are necessary; that behavior and remote services are accurately described; that data practices are disclosed; and that the submission contains no malware, credential theft, hidden mining, spyware, intentional deception, infringement or undisclosed tracking.',
    'The operator may inspect, reject, request changes, suspend, delist, disable distribution, revoke malicious releases, preserve evidence and respond to valid legal notices. Review reduces risk but is not a guarantee that third-party software is defect-free.',
    'Liability limitations apply only to the maximum extent permitted by applicable law and do not exclude mandatory obligations.'
  ].join('\n\n')
}

export async function currentPublisherTerms(env: Env): Promise<{ version: string; sha256: string; text: string; config: HubLegalConfig }> {
  const config = requireLegalConfig(env)
  const text = publisherTermsText(config.operatorName)
  return { version: PUBLISHER_TERMS_VERSION, sha256: await sha256(text), text, config }
}

export async function requirePublisherTerms(env: Env, publisherId: string): Promise<void> {
  const terms = await currentPublisherTerms(env)
  const accepted = await env.DB.prepare('SELECT 1 accepted FROM publisher_terms_acceptances WHERE publisher_id=?1 AND terms_version=?2 AND terms_sha256=?3').bind(publisherId, terms.version, terms.sha256).first<{ accepted: number }>()
  if (!accepted) throw new HttpError(428, 'Accept the current Publisher Terms before publishing.')
}
