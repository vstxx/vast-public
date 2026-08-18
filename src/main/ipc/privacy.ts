import type { WorkspaceIdentitySettings } from '../../shared/types'
import { assertNonEmptyString, assertObject, assertPositiveInteger, fail, ok, type IpcHandle } from './registration'

export function registerPrivacyIpc(handle: IpcHandle): void {
  handle('vast:privacy:clear-site-data', async (_event, origin?: string, webContentsId?: number) => {
    try {
      if (origin !== undefined && (typeof origin !== 'string' || !/^https?:\/\//.test(origin))) throw new Error('Invalid site origin.')
      if (webContentsId !== undefined) assertPositiveInteger(webContentsId, 'web contents identifier')
      await (await import('../sessions')).clearSiteData(origin, webContentsId)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:privacy:site-information', async (_event, webContentsId: number, url: string) => {
    try {
      assertPositiveInteger(webContentsId, 'web contents identifier')
      assertNonEmptyString(url, 'page URL', 32_768)
      return { ok: true, info: await (await import('../sessions')).getSiteInformation(webContentsId, url) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:privacy:filter-status', async () => ({
    ok: true,
    status: (await import('../privacy-filter-lists')).privacyFilterStatus()
  }))

  handle('vast:privacy:update-filters', async () => ({
    ok: true,
    status: await (await import('../privacy-filter-lists')).updatePrivacyFilters(true)
  }))

  handle('vast:privacy:configure-identity', async (
    _event,
    webContentsId: number,
    identity: WorkspaceIdentitySettings,
    url: string,
    identityId: string
  ) => {
    try {
      assertPositiveInteger(webContentsId, 'web contents identifier')
      assertObject(identity, 'identity configuration')
      assertNonEmptyString(url, 'page URL', 32_768)
      assertNonEmptyString(identityId, 'workspace identity', 256)
      await (await import('../sessions')).configureWebContentsIdentity(webContentsId, identity, url, identityId)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })
}
