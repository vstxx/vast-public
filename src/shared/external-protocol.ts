const BLOCKED_EXTERNAL_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'chrome:',
  'data:',
  'devtools:',
  'file:',
  'http:',
  'https:',
  'javascript:',
  'vast:'
])

const MAX_EXTERNAL_PROTOCOL_URL_LENGTH = 32 * 1024
const EXTERNAL_PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]{1,31}:$/i

export interface ExternalProtocolTarget {
  url: string
  scheme: string
}

export function externalProtocolTarget(rawUrl: string): ExternalProtocolTarget | undefined {
  const url = rawUrl.trim()
  if (!url || url.length > MAX_EXTERNAL_PROTOCOL_URL_LENGTH) return undefined
  try {
    const parsed = new URL(url)
    const scheme = parsed.protocol.toLowerCase()
    if (!EXTERNAL_PROTOCOL_PATTERN.test(scheme) || BLOCKED_EXTERNAL_PROTOCOLS.has(scheme)) return undefined
    return { url, scheme }
  } catch {
    return undefined
  }
}
