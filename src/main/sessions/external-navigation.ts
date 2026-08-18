import { clipboard, shell } from 'electron/common'
import type { BrowserWindow } from 'electron/main'
import type { BrowserSettings } from '../../shared/types'
import { requestRendererPrompt } from '../ui-bridge'

interface ExternalNavigationDependencies {
  isSafeWebUrl: (url: string) => boolean
  logOAuthPopupFlow: (message: string) => void
  redactUrl: (url: string) => string
}

interface OAuthExternalFallbackRequest {
  url: string
  fallbackUrl?: string
  reason?: string
}

function oauthFallbackRequest(input: unknown): OAuthExternalFallbackRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid OAuth fallback request.')
  const request = input as { url?: unknown; fallbackUrl?: unknown; reason?: unknown }
  if (typeof request.url !== 'string' || !request.url.trim()) throw new Error('Invalid OAuth fallback URL.')
  return {
    url: request.url.trim(),
    fallbackUrl: typeof request.fallbackUrl === 'string' ? request.fallbackUrl.trim() : undefined,
    reason: typeof request.reason === 'string' ? request.reason.trim().slice(0, 80) : undefined
  }
}

export async function requestOAuthFallback(
  input: unknown,
  mainWindow: BrowserWindow | undefined,
  dependencies: ExternalNavigationDependencies
): Promise<void> {
  const request = oauthFallbackRequest(input)
  const url = dependencies.isSafeWebUrl(request.url)
    ? request.url
    : request.fallbackUrl && dependencies.isSafeWebUrl(request.fallbackUrl)
      ? request.fallbackUrl
      : undefined

  if (!url) throw new Error('Only http(s) OAuth fallback URLs can be opened externally.')

  const logReason = request.reason || 'unknown'
  const detailReason = request.reason || 'provider-blocked'
  dependencies.logOAuthPopupFlow(`fallback prompt reason=${logReason} url=${dependencies.redactUrl(url)}`)

  if (mainWindow && !mainWindow.isDestroyed()) {
    const result = await requestRendererPrompt(mainWindow, {
      tone: 'question',
      title: 'Sign-in blocked inside Vast',
      message: 'This sign-in provider appears to be blocking embedded browser login.',
      detail: `Open the sign-in page in your system browser to continue.\n\nURL: ${dependencies.redactUrl(url)}\nReason: ${detailReason}`,
      actions: [
        { id: 'open-system', label: 'Open browser', tone: 'primary' },
        { id: 'copy-link', label: 'Copy link', tone: 'default' },
        { id: 'dismiss', label: 'Dismiss', tone: 'danger' }
      ]
    })

    if (result === 'copy-link') {
      clipboard.writeText(url)
      dependencies.logOAuthPopupFlow(`fallback copied reason=${logReason} url=${dependencies.redactUrl(url)}`)
      return
    }
    if (result !== 'open-system') {
      dependencies.logOAuthPopupFlow(`fallback dismissed reason=${logReason} url=${dependencies.redactUrl(url)}`)
      return
    }
  }

  await shell.openExternal(url)
  dependencies.logOAuthPopupFlow(`fallback opened reason=${logReason} url=${dependencies.redactUrl(url)}`)
}

export async function openExternalWebUrl(
  url: string,
  mainWindow: BrowserWindow | undefined,
  settings: BrowserSettings | undefined,
  isSafeWebUrl: (url: string) => boolean
): Promise<void> {
  if (!isSafeWebUrl(url)) throw new Error('Only http(s) URLs can be opened externally.')
  if (mainWindow && settings?.security.confirmExternalLinks) {
    const parsed = new URL(url)
    const result = await requestRendererPrompt(mainWindow, {
      tone: 'question',
      title: 'Open external link',
      message: `Open ${parsed.hostname} in your system browser?`,
      detail: url,
      actions: [
        { id: 'open', label: 'Open', tone: 'primary' },
        { id: 'cancel', label: 'Cancel', tone: 'danger' }
      ]
    })
    if (result !== 'open') throw new Error('External link cancelled.')
  }
  await shell.openExternal(url)
}
