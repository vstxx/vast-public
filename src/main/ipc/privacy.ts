import type { WorkspaceIdentitySettings } from '../../shared/types'
import type { WebContents } from 'electron/main'
import { clearSiteData, configureWebContentsIdentity, getSiteInformation } from '../sessions'
import { assertNonEmptyString, assertObject, assertPositiveInteger, fail, ok, type IpcHandle } from './registration'

export function registerPrivacyIpc(handle: IpcHandle, resolveOwnedGuest: (sender: WebContents, id: number) => WebContents): void {
  handle('vast:privacy:clear-site-data', async (event, origin?: string, webContentsId?: number) => {
    try {
      if (origin !== undefined && (typeof origin !== 'string' || !/^https?:\/\//.test(origin))) throw new Error('Invalid site origin.')
      if (webContentsId !== undefined) {
        assertPositiveInteger(webContentsId, 'web contents identifier')
        resolveOwnedGuest(event.sender, webContentsId)
      }
      await clearSiteData(origin, webContentsId)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:privacy:site-information', async (event, webContentsId: number, url: string) => {
    try {
      assertPositiveInteger(webContentsId, 'web contents identifier')
      resolveOwnedGuest(event.sender, webContentsId)
      assertNonEmptyString(url, 'page URL', 32_768)
      return { ok: true, info: await getSiteInformation(webContentsId, url) }
    } catch (error) {
      return fail(error)
    }
  })



  handle('vast:privacy:configure-identity', async (
    event,
    webContentsId: number,
    identity: WorkspaceIdentitySettings,
    url: string,
    identityId: string
  ) => {
    try {
      assertPositiveInteger(webContentsId, 'web contents identifier')
      resolveOwnedGuest(event.sender, webContentsId)
      assertObject(identity, 'identity configuration')
      assertNonEmptyString(url, 'page URL', 32_768)
      assertNonEmptyString(identityId, 'workspace identity', 256)
      await configureWebContentsIdentity(webContentsId, identity, url, identityId)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })
}
