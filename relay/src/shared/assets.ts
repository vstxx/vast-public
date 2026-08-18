import type { AssetMime } from './types'
import { ValidationError } from './validation'

export function validateAssetMagic(bytes: Uint8Array, mime: AssetMime): void {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const isPng = bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
  const isGif = bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')
  const isWebp = bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
  if ((mime === 'image/png' && !isPng) || (mime === 'image/gif' && !isGif) || (mime === 'image/webp' && !isWebp)) {
    throw new ValidationError('Asset bytes do not match the declared image format.', 415)
  }
}
