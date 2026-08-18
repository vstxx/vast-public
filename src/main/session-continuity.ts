import { app, session, type Session } from 'electron/main'
import { VAST_DEFAULT_WEBVIEW_PARTITION } from '../shared/oauth'
import {
  prepareLegacyDefaultSessionFiles,
  writeLegacySessionMigrationMarker,
  type LegacySessionMigrationPlan
} from './session-continuity-files'

export type { LegacySessionMigrationPlan } from './session-continuity-files'

/**
 * Stages the former default Electron session into Vast's persistent partition.
 * This runs before app readiness, while Chromium databases are still closed.
 * Existing target stores are never overwritten.
 */
export function prepareLegacyDefaultSessionMigration(sessionDataRoot = app.getPath('sessionData')): LegacySessionMigrationPlan {
  return prepareLegacyDefaultSessionFiles(sessionDataRoot)
}

function cookieKey(cookie: Electron.Cookie): string {
  return `${(cookie.domain ?? '').toLowerCase()}\u0000${cookie.path ?? '/'}\u0000${cookie.name}`
}

function cookieSetDetails(cookie: Electron.Cookie): Electron.CookiesSetDetails | undefined {
  const domain = cookie.domain?.replace(/^\./, '')
  if (!domain) return undefined
  const path = cookie.path?.startsWith('/') ? cookie.path : '/'
  const details: Electron.CookiesSetDetails = {
    url: `${cookie.secure ? 'https' : 'http'}://${domain}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite
  }
  if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain
  if (!cookie.session && typeof cookie.expirationDate === 'number') details.expirationDate = cookie.expirationDate
  return details
}

export function persistentBrowserSessions(): Session[] {
  return [...new Set([session.defaultSession, session.fromPartition(VAST_DEFAULT_WEBVIEW_PARTITION)])]
}

/** Completes the staged migration without replacing cookies already in the new partition. */
export async function completeLegacyDefaultSessionMigration(plan: LegacySessionMigrationPlan): Promise<void> {
  if (!plan.needed) return

  const sourceSession = session.defaultSession
  const targetSession = session.fromPartition(VAST_DEFAULT_WEBVIEW_PARTITION)
  const [sourceCookies, targetCookies] = await Promise.all([
    sourceSession.cookies.get({}),
    targetSession.cookies.get({})
  ])
  const targetKeys = new Set(targetCookies.map(cookieKey))
  let importedCookies = 0
  const failedCookies: string[] = []

  for (const cookie of sourceCookies) {
    if (targetKeys.has(cookieKey(cookie))) continue
    const details = cookieSetDetails(cookie)
    if (!details) continue
    try {
      await targetSession.cookies.set(details)
      targetKeys.add(cookieKey(cookie))
      importedCookies += 1
    } catch {
      failedCookies.push(cookieKey(cookie))
    }
  }

  targetSession.flushStorageData()
  await targetSession.cookies.flushStore()
  if (failedCookies.length > 0) {
    throw new Error(`Could not migrate ${failedCookies.length} legacy website cookie(s). The migration will retry on next launch.`)
  }
  writeLegacySessionMigrationMarker(plan, {
    sourceItems: plan.sourceItems.length,
    sourceCookies: sourceCookies.length,
    preservedTargetCookies: targetCookies.length,
    importedCookies
  })
}

/** Flushes every known persistent website session before an updater restart. */
export async function checkpointPersistentBrowserSessions(extraSessions: Iterable<Session> = []): Promise<number> {
  const sessions = new Set<Session>([...persistentBrowserSessions(), ...extraSessions])
  const persistent = [...sessions].filter((targetSession) => {
    try {
      return targetSession.isPersistent()
    } catch {
      return false
    }
  })
  await Promise.all(persistent.map(async (targetSession) => {
    targetSession.flushStorageData()
    await targetSession.cookies.flushStore()
  }))
  return persistent.length
}
