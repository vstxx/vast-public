import { SCOPE, isEngineEvent, type DownloadProgress, type EnginePhase, type Reply } from '../shared/protocol.ts'
import { t, uiLanguage, type MessageKey } from '../shared/i18n.ts'

export async function request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...payload }) as Reply<T> | undefined
  if (!reply) throw new Error('The extension did not answer')
  if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code })
  return reply.value
}

export function onEngineEvents(handlers: { progress?: (progress: DownloadProgress) => void; phase?: (phase: EnginePhase) => void }): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html') || !isEngineEvent(message)) return false
    if (message.type === 'engine:progress') handlers.progress?.(message.progress)
    else handlers.phase?.(message.phase)
    return false
  })
}

type Child = Node | string | null | undefined | false

// A small element builder: text is always assigned as text, never parsed as markup.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key === 'className') element.className = String(value)
    else if (key in element && key !== 'list') (element as unknown as Record<string, unknown>)[key] = value
    else element.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) element.append(child)
  return element
}

export function localize(root: ParentNode = document): void {
  document.documentElement.lang = uiLanguage()
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) element.textContent = t(element.dataset.i18n as MessageKey)
}

export const PHASE_KEYS: Record<EnginePhase, MessageKey> = {
  uninitialized: 'stateUninitialized',
  loading: 'stateLoading',
  ready: 'stateReady',
  translating: 'stateTranslating',
  idle: 'stateIdle',
  released: 'stateReleased',
  error: 'stateError'
}
