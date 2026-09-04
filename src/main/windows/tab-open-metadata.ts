import type { TabOpenNavigationMetadata } from '../../shared/types'

/**
 * Structural mirror of the fields Vast consumes from Electron's
 * setWindowOpenHandler details. Kept local so the converter stays a pure,
 * unit-testable function independent of the Electron runtime.
 */
export interface WindowOpenMetadataInput {
  referrer?: { url: string; policy: string } | null
  postBody?: {
    contentType: string
    boundary?: string
    data: Array<{ type: string; bytes?: Uint8Array; filePath?: string; offset?: number; length?: number }>
  } | null
}

function isHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Extracts the navigation metadata a Vast-tab initial request must replay to
 * match Chromium: the authoritative referrer from the window-open event and
 * the form POST body when a form targeted _blank. Returns undefined when the
 * open carries nothing beyond a plain GET.
 */
export function tabOpenNavigationMetadata(details: WindowOpenMetadataInput): TabOpenNavigationMetadata | undefined {
  const referrer = details.referrer && details.referrer.url && isHttpUrl(details.referrer.url)
    ? { url: details.referrer.url, policy: details.referrer.policy }
    : undefined
  const entries = details.postBody && Array.isArray(details.postBody.data)
    ? details.postBody.data
        .map((entry) => {
          if (entry.type === 'rawData' && entry.bytes instanceof Uint8Array) {
            return { type: 'rawData' as const, bytes: entry.bytes }
          }
          if (entry.type === 'file' && typeof entry.filePath === 'string') {
            return { type: 'file' as const, filePath: entry.filePath, offset: entry.offset, length: entry.length }
          }
          return undefined
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    : []
  if (!referrer && entries.length === 0) return undefined
  const postBody = entries.length > 0 && details.postBody
    ? { contentType: details.postBody.contentType, boundary: details.postBody.boundary, data: entries }
    : undefined
  if (referrer && postBody) return { referrer, postBody }
  if (referrer) return { referrer }
  return { postBody }
}
