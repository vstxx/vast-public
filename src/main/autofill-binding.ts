export interface AutofillRequestBinding {
  requestedOrigin: string
  requestedWebContentsId: number
}

export interface AutofillWebContentsSnapshot {
  id: number
  url: string
}

function httpOrigin(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function autofillRequestMatchesWebContents(
  request: AutofillRequestBinding,
  contents: AutofillWebContentsSnapshot
): boolean {
  if (!Number.isInteger(request.requestedWebContentsId) || request.requestedWebContentsId <= 0) return false
  if (request.requestedWebContentsId !== contents.id) return false
  return httpOrigin(contents.url) === httpOrigin(request.requestedOrigin)
}
