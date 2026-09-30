export function assertGuestOwnedBySender(
  senderId: number,
  target: { hostWebContents?: { id: number } | null; isDestroyed: () => boolean } | undefined
): asserts target is { hostWebContents?: { id: number } | null; isDestroyed: () => boolean } {
  if (!target || target.isDestroyed()) throw new Error('Target webContents is unavailable.')
  if (target.hostWebContents?.id !== senderId) {
    throw new Error('Rejected guest webContents outside this window.')
  }
}
