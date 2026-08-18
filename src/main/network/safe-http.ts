import net from 'node:net'

export const MAX_NETWORK_REDIRECTS = 5

export function isPrivateNetworkIp(ip: string): boolean {
  if (net.isIP(ip) !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

export function safeHttpUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.username || parsed.password || hostname === 'localhost') return undefined
    if (isPrivateNetworkIp(hostname) || hostname.endsWith('.local')) return parsed.toString()
  } catch {
    return undefined
  }
  return undefined
}

export async function fetchPrivateNetworkText(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ text: string; headers: Headers; url: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let currentUrl = safeHttpUrl(url)
    if (!currentUrl) throw new Error('Network discovery URL is outside the private network allowlist.')

    for (let hop = 0; hop <= MAX_NETWORK_REDIRECTS; hop += 1) {
      const response = await fetchImpl(currentUrl, { signal: controller.signal, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) throw new Error('Network discovery redirect is missing a location.')
        if (hop === MAX_NETWORK_REDIRECTS) throw new Error('Network discovery redirect limit exceeded.')
        const nextUrl = safeHttpUrl(new URL(location, currentUrl).toString())
        if (!nextUrl) throw new Error('Network discovery redirect left the private network allowlist.')
        currentUrl = nextUrl
        continue
      }
      if (!response.ok) throw new Error(`Network discovery request failed with status ${response.status}.`)
      return { text: await response.text(), headers: response.headers, url: currentUrl }
    }
    throw new Error('Network discovery redirect limit exceeded.')
  } finally {
    clearTimeout(timer)
  }
}
