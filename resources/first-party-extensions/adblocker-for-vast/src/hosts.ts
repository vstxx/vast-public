/** Exact hosts only: disabling example.com does not disable unrelated subdomains. */
export function adblockHostname(input: string): string | undefined {
  if (typeof input !== 'string' || input.length > 32_768 || /[\s\\]/.test(input)) return undefined
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.hostname.toLowerCase().replace(/\.$/, '') || undefined
  } catch { return undefined }
}

export function normalizeAdblockHost(input: string): string | undefined {
  if (typeof input !== 'string' || input.length > 253 || /[/?#@\s\\]/.test(input.trim())) return undefined
  const value = input.trim()
  const host = adblockHostname(`https://${value}/`)
  // Ports belong to origins, not this hostname allowlist. IPv6 must be bracketed.
  if (!host || (value.includes(':') && !/^\[[0-9a-fA-F:]+\]$/.test(value))) return undefined
  if (!host.startsWith('[') && !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined
  return host
}
