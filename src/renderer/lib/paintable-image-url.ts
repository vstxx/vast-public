// Chromium ignores URLs longer than 2 MB, so a typical wallpaper passed as a
// data: URL silently fails to paint. The same bytes are painted through a
// short blob: URL instead. The two most recent images stay alive so the New
// Tab page and the Settings thumbnail can show the same one while switching.

const DATA_IMAGE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/
const recent: Array<{ source: string; url: string }> = []

export function paintableImageUrl(dataUrl: string): string {
  const cached = recent.find((entry) => entry.source === dataUrl)
  if (cached) return cached.url
  const match = DATA_IMAGE.exec(dataUrl)
  if (!match) return dataUrl
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
  recent.unshift({ source: dataUrl, url })
  for (const stale of recent.splice(2)) URL.revokeObjectURL(stale.url)
  return url
}
