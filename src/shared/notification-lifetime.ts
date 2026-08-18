export function shouldAutoDismissNotification(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs > 0
}
