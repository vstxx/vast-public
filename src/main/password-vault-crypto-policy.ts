export function vaultStorageBackendIsSecure(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  selectedBackend?: string
): boolean {
  if (!encryptionAvailable) return false
  return platform !== 'linux' || selectedBackend !== 'basic_text'
}
