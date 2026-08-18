import { fail, type IpcHandle } from './registration'

export function registerNoticesIpc(handle: IpcHandle): void {
  handle('vast:notices:list', async () => {
    try {
      return { ok: true, result: await (await import('../notices')).getVastNotices() }
    } catch (error) {
      return fail(error)
    }
  })
}
