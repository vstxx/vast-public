export type ExtensionMatchScheme = '*' | 'http' | 'https' | 'file' | 'ftp'

export interface ParsedExtensionMatchPattern {
  allUrls: boolean
  scheme: ExtensionMatchScheme | '<all_urls>'
  host: string
  port: '*' | string
  path: string
}

const HOST_LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i

function validHost(host: string): boolean {
  if (!host || host.length > 253 || /[^\x21-\x7e]/.test(host) || host.includes('@')) return false
  if (host === '*') return true
  if (host.startsWith('[') && host.endsWith(']')) {
    try { return new URL(`http://${host}/`).hostname.toLowerCase() === host.toLowerCase() } catch { return false }
  }
  if (host.includes(':')) return false
  const candidate = host.startsWith('*.') ? host.slice(2) : host
  if (!candidate || candidate.includes('*') || candidate.endsWith('.')) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) return candidate.split('.').every((part) => Number(part) <= 255)
  return candidate.split('.').every((label) => HOST_LABEL.test(label))
}

function splitAuthority(authority: string): { host: string; port: '*' | string } | undefined {
  let host = authority
  let port: '*' | string = '*'
  if (authority.startsWith('[')) {
    const bracket = authority.indexOf(']')
    if (bracket < 0) return undefined
    host = authority.slice(0, bracket + 1)
    const remainder = authority.slice(bracket + 1)
    if (remainder) {
      if (!remainder.startsWith(':')) return undefined
      port = remainder.slice(1)
    }
  } else {
    const separator = authority.lastIndexOf(':')
    if (separator >= 0) {
      host = authority.slice(0, separator)
      port = authority.slice(separator + 1)
    }
  }
  if (port !== '*' && (!/^\d{1,5}$/.test(port) || Number(port) > 65_535)) return undefined
  return { host, port }
}

export function parseExtensionMatchPattern(pattern: string): ParsedExtensionMatchPattern | undefined {
  if (pattern === '<all_urls>') return { allUrls: true, scheme: '<all_urls>', host: '*', port: '*', path: '/*' }
  if (!pattern || pattern.length > 2_048 || /[\u0000-\u0020\u007f]/.test(pattern)) return undefined
  const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i.exec(pattern)
  if (!match) return undefined
  const scheme = match[1].toLowerCase() as ExtensionMatchScheme
  const authority = splitAuthority(match[2].toLowerCase())
  if (!authority) return undefined
  const { host, port } = authority
  const path = match[3]
  if (!path.startsWith('/') || path.includes('#')) return undefined
  if (scheme === 'file') {
    if (host !== '' || port !== '*') return undefined
  } else if (!validHost(host)) return undefined
  return { allUrls: false, scheme, host, port, path }
}

function wildcardPathExpression(path: string): RegExp {
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`)
}

export function matchesExtensionMatchPattern(inputUrl: string, pattern: string): boolean {
  const parsed = parseExtensionMatchPattern(pattern)
  if (!parsed) return false
  let url: URL
  try { url = new URL(inputUrl) } catch { return false }
  if (parsed.allUrls) return ['http:', 'https:', 'file:', 'ftp:'].includes(url.protocol)
  if (parsed.scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== `${parsed.scheme}:`) return false
  if (parsed.scheme !== 'file') {
    const urlHost = url.hostname.toLowerCase()
    if (parsed.host === '*') {
      if (!urlHost) return false
    } else if (parsed.host.startsWith('*.')) {
      const suffix = parsed.host.slice(2)
      if (urlHost !== suffix && !urlHost.endsWith(`.${suffix}`)) return false
    } else if (urlHost !== parsed.host) return false
    if (parsed.port !== '*') {
      const defaultPort = url.protocol === 'http:' ? '80' : url.protocol === 'https:' ? '443' : url.protocol === 'ftp:' ? '21' : ''
      if ((url.port || defaultPort) !== parsed.port) return false
    }
  }
  return wildcardPathExpression(parsed.path).test(`${url.pathname}${url.search}`)
}
