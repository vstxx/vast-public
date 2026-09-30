import net from 'node:net'

export const MAX_NETWORK_REDIRECTS = 5
export const MAX_NETWORK_RESPONSE_BYTES = 1024 * 1024

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > MAX_NETWORK_RESPONSE_BYTES) throw new Error('Network discovery response is too large.')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

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
      const contentLength = response.headers.get('content-length')
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_NETWORK_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Network discovery response is too large.')
      }
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
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`Network discovery request failed with status ${response.status}.`)
      }
      return { text: await readBoundedText(response), headers: response.headers, url: currentUrl }
    }
    throw new Error('Network discovery redirect limit exceeded.')
  } finally {
    clearTimeout(timer)
  }
}
