import { normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TrustedRendererOptions {
  isPackaged: boolean
  rendererUrl?: string
  packagedRendererPath?: string
}

function comparablePath(input: string): string {
  const resolved = normalize(resolve(input))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isTrustedRendererUrl(rawUrl: string, options: TrustedRendererOptions): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  // Electron smoke/preview launches are not app.isPackaged but still load the
  // built file renderer. With no configured Vite URL, apply the same exact
  // canonical file boundary as a packaged release.
  if (options.isPackaged || !options.rendererUrl) {
    if (parsed.protocol !== 'file:' || !options.packagedRendererPath || parsed.username || parsed.password || parsed.host) return false
    try {
      return comparablePath(fileURLToPath(parsed)) === comparablePath(options.packagedRendererPath)
    } catch {
      return false
    }
  }

  if (!options.rendererUrl) return false
  try {
    const trusted = new URL(options.rendererUrl)
    if (trusted.protocol !== 'http:' && trusted.protocol !== 'https:') return false
    if (parsed.protocol !== trusted.protocol || parsed.username || parsed.password) return false
    return parsed.origin === trusted.origin
  } catch {
    return false
  }
}

export function isSafeDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
