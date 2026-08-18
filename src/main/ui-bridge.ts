import { type BrowserWindow, type WebContents } from 'electron/main'
import { randomUUID } from 'node:crypto'
import type { UiNotificationPayload, UiPromptPayload } from '../shared/types'
import { windowRegistry } from './windows/WindowRegistry'

interface PromptResolverEntry {
  resolve: (actionId: string | undefined) => void
  timeout: NodeJS.Timeout
  ownerWebContentsId: number
}

const promptResolvers = new Map<string, PromptResolverEntry>()

function targetWindow(mainWindow?: BrowserWindow): BrowserWindow | undefined {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return windowRegistry.focusedVastWindow()
}

function clearPromptResolver(promptId: string): PromptResolverEntry | undefined {
  const entry = promptResolvers.get(promptId)
  if (!entry) return undefined
  clearTimeout(entry.timeout)
  promptResolvers.delete(promptId)
  return entry
}

export function showRendererNotification(
  mainWindow: BrowserWindow | undefined,
  notification: Omit<UiNotificationPayload, 'id'> & { id?: string }
): void {
  const window = targetWindow(mainWindow)
  if (!window) return
  const payload: UiNotificationPayload = {
    id: notification.id ?? randomUUID(),
    durationMs:
      notification.durationMs ??
      (notification.tone === 'error' ? 12_000 : notification.tone === 'warning' ? 9_000 : 4_800),
    ...notification
  }
  window.webContents.send('vast:ui:notification', payload)
}

export async function requestRendererPrompt(
  mainWindow: BrowserWindow | undefined,
  prompt: Omit<UiPromptPayload, 'id'> & { id?: string },
  timeoutMs = 60_000
): Promise<string | undefined> {
  const window = targetWindow(mainWindow)
  if (!window) return undefined

  const payload: UiPromptPayload = {
    id: prompt.id ?? randomUUID(),
    ...prompt
  }

  return await new Promise<string | undefined>((resolve) => {
    const timeout = setTimeout(() => {
      clearPromptResolver(payload.id)
      resolve(undefined)
    }, timeoutMs)

    promptResolvers.set(payload.id, { resolve, timeout, ownerWebContentsId: window.webContents.id })
    window.webContents.send('vast:ui:prompt', payload)
  })
}

export function resolveRendererPrompt(sender: WebContents, promptId: string, actionId: string): boolean {
  const pending = promptResolvers.get(promptId)
  if (!pending || pending.ownerWebContentsId !== sender.id) return false
  const entry = clearPromptResolver(promptId)
  if (!entry) return false
  entry.resolve(actionId)
  return true
}

export function cancelRendererPrompt(promptId: string): boolean {
  const entry = clearPromptResolver(promptId)
  if (!entry) return false
  entry.resolve(undefined)
  return true
}
