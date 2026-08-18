type LogLevel = 'info' | 'warn' | 'error'

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300)
}

export function logEvent(level: LogLevel, event: string, detail: Record<string, string | number | boolean | null> = {}): void {
  const payload = JSON.stringify({ event, ...detail })
  if (level === 'error') console.error(payload)
  else if (level === 'warn') console.warn(payload)
  else console.log(payload)
}

export function logFailure(event: string, error: unknown, detail: Record<string, string | number | boolean | null> = {}): void {
  logEvent('error', event, { ...detail, error: safeError(error) })
}
