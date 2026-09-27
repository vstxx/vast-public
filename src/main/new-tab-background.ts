import { nativeImage } from 'electron'
import { dialog, type BrowserWindow } from 'electron/main'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dataFilePath } from './data-path'

const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024
const MAX_BACKGROUND_DIMENSION = 16_384
const MAX_BACKGROUND_PIXELS = 100_000_000
const BACKGROUND_FILE_NAME = 'new-tab-background.image'

let cachedPath = ''
let cachedDataUrl: string | undefined

export type SupportedBackgroundMime = 'image/png' | 'image/jpeg'

export function newTabBackgroundMime(bytes: Uint8Array): SupportedBackgroundMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

function checkedDataUrl(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > MAX_BACKGROUND_BYTES) {
    throw new Error('The selected image must be 20 MB or smaller.')
  }
  const mime = newTabBackgroundMime(bytes)
  if (!mime) throw new Error('The selected file is not a valid PNG or JPEG image.')
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('The selected image could not be decoded.')
  const { width, height } = image.getSize()
  if (
    width < 1 || height < 1 ||
    width > MAX_BACKGROUND_DIMENSION || height > MAX_BACKGROUND_DIMENSION ||
    width * height > MAX_BACKGROUND_PIXELS
  ) throw new Error('The selected image dimensions are too large.')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function readBackgroundFile(path: string): Promise<Buffer> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('The selected background is not a file.')
  if (info.size === 0 || info.size > MAX_BACKGROUND_BYTES) {
    throw new Error('The selected image must be 20 MB or smaller.')
  }
  return readFile(path)
}

export async function getNewTabBackgroundDataUrl(): Promise<string | undefined> {
  const path = dataFilePath(BACKGROUND_FILE_NAME)
  if (cachedPath === path && cachedDataUrl) return cachedDataUrl
  try {
    const bytes = await readBackgroundFile(path)
    const dataUrl = checkedDataUrl(bytes)
    cachedPath = path
    cachedDataUrl = dataUrl
    return dataUrl
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function chooseNewTabBackground(owner: BrowserWindow): Promise<{ canceled: boolean; dataUrl?: string }> {
  const result = await dialog.showOpenDialog(owner, {
    title: 'Choose New Tab background',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const bytes = await readBackgroundFile(result.filePaths[0])
  const dataUrl = checkedDataUrl(bytes)
  const path = dataFilePath(BACKGROUND_FILE_NAME)
  await writeFile(path, bytes)
  cachedPath = path
  cachedDataUrl = dataUrl
  return { canceled: false, dataUrl }
}
