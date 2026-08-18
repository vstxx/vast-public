import { extname } from 'node:path'

export const dangerousDownloadExtensions = new Set([
  '.exe', '.bat', '.cmd', '.com', '.vbs', '.wsf', '.ps1', '.psm1', '.scr', '.lnk', '.reg', '.msi', '.dll', '.jar',
  '.sh', '.bash', '.zsh', '.fish', '.run', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.appimage'
])

export const benignDecoyExtensions = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
  '.mp4', '.mp3', '.wav', '.ogg', '.flac', '.avi', '.mkv', '.mov', '.txt', '.csv', '.json', '.xml', '.html', '.htm',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'
])

export function detectDecoyDoubleExtension(filename: string): string | null {
  const outer = extname(filename).toLowerCase()
  const inner = extname(filename.slice(0, filename.length - outer.length)).toLowerCase()
  return benignDecoyExtensions.has(inner) && dangerousDownloadExtensions.has(outer)
    ? `Double extension detected: "${filename}" hides an executable behind a decoy extension - a common malware tactic.`
    : null
}

export function detectExecutableMimeMismatch(filename: string, mimeType: string): string | null {
  const extension = extname(filename).toLowerCase()
  const mime = mimeType.toLowerCase()
  const executableMimes = ['application/x-msdownload', 'application/x-msdos-program', 'application/x-executable', 'application/x-elf']
  return executableMimes.some((candidate) => mime.includes(candidate)) && benignDecoyExtensions.has(extension)
    ? `Server sent MIME type "${mimeType}" for "${filename}" which does not match the file extension.`
    : null
}
