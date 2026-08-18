import type { BrowserWindow, IpcMainInvokeEvent } from 'electron/main'

export type IpcHandle = <TArgs extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => unknown
) => void

export type SenderWindowFor = (event: IpcMainInvokeEvent) => BrowserWindow

export function ok(): { ok: true } {
  return { ok: true }
}

export function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export function assertNonEmptyString(value: unknown, label: string, maxLength = 4096): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > maxLength) throw new Error(`Invalid ${label}.`)
}

export function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`Invalid ${label}.`)
}

export function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
}
