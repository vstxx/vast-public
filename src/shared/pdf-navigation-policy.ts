const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf'])
const GENERIC_BINARY_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/download'])

export interface PdfNavigationResponse {
  url: string
  resourceType: string
  statusCode: number
  responseHeaders?: Record<string, string[]>
}

export interface PdfResponseClassification {
  capture: boolean
  mimeType: string
  filename?: string
  contentLength?: number
}

function firstHeader(headers: Record<string, string[]> | undefined, wanted: string): string | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find((name) => name.toLowerCase() === wanted)
  return key ? headers[key]?.[0]?.trim() : undefined
}

function normalizedMime(headers: Record<string, string[]> | undefined): string {
  return (firstHeader(headers, 'content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
}

function filenameFromDisposition(value: string | undefined): string | undefined {
  if (!value) return undefined
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value)
  const candidate = encoded ?? plain?.[1] ?? plain?.[2]
  if (!candidate) return undefined
  try {
    return decodeURIComponent(candidate.trim()).split(/[\\/]/).pop()?.trim() || undefined
  } catch {
    return candidate.trim().split(/[\\/]/).pop()?.trim() || undefined
  }
}

function urlLooksLikePdf(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return /\.pdf$/i.test(url.pathname)
  } catch {
    return false
  }
}

export function classifyPdfNavigationResponse(input: PdfNavigationResponse): PdfResponseClassification {
  const mimeType = normalizedMime(input.responseHeaders)
  const dispositionFilename = filenameFromDisposition(firstHeader(input.responseHeaders, 'content-disposition'))
  const contentLengthValue = Number(firstHeader(input.responseHeaders, 'content-length'))
  const contentLength = Number.isSafeInteger(contentLengthValue) && contentLengthValue >= 0 ? contentLengthValue : undefined
  const protocolAllowed = (() => {
    try {
      return ['http:', 'https:'].includes(new URL(input.url).protocol)
    } catch {
      return false
    }
  })()
  const successfulResponse = input.statusCode >= 200 && input.statusCode < 300
  const semanticPdf = PDF_MIME_TYPES.has(mimeType) || Boolean(dispositionFilename && /\.pdf$/i.test(dispositionFilename))
  const conservativeUrlFallback = urlLooksLikePdf(input.url) && GENERIC_BINARY_MIME_TYPES.has(mimeType)
  return {
    capture: protocolAllowed && input.resourceType === 'mainFrame' && successfulResponse && (semanticPdf || conservativeUrlFallback),
    mimeType: PDF_MIME_TYPES.has(mimeType) ? mimeType : 'application/pdf',
    filename: dispositionFilename,
    contentLength
  }
}

export function pdfAttachmentHeaders(
  headers: Record<string, string[]> | undefined,
  filename = 'document.pdf'
): Record<string, string[]> {
  const next = { ...(headers ?? {}) }
  for (const name of Object.keys(next)) {
    if (name.toLowerCase() === 'content-disposition') delete next[name]
  }
  const safe = filename.replace(/[\r\n"\\/]/g, '_').slice(0, 180) || 'document.pdf'
  next['Content-Disposition'] = [`attachment; filename="${safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`}"`]
  return next
}
