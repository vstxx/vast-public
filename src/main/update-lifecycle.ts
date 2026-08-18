let updateRestartInProgress = false

export function beginUpdateRestart(): void {
  updateRestartInProgress = true
}

export function cancelUpdateRestart(): void {
  updateRestartInProgress = false
}

export function isUpdateRestartInProgress(): boolean {
  return updateRestartInProgress
}
