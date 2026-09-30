import type { IpcHandle } from './registration'
import { authorizeAvidaeInitiator, revokeAvidaeInitiator } from '../avidae-auth'

export function registerAvidaeIpc(handle: IpcHandle): void {
  handle('vast:avidae:status', async (event) => {
    const status = (await import('../avidae')).getAvidaeStatus()
    if (status.state === 'running') authorizeAvidaeInitiator(event.sender.id)
    return status
  })
  handle('vast:avidae:start', async (event) => {
    const status = await (await import('../avidae')).startAvidae()
    if (status.state === 'running') authorizeAvidaeInitiator(event.sender.id)
    return status
  })
  handle('vast:avidae:stop', async (event) => {
    revokeAvidaeInitiator(event.sender.id)
    return (await import('../avidae')).stopAvidae()
  })
  handle('vast:avidae:install-dependencies', async (event) => {
    const status = await (await import('../avidae')).installAvidaeDependencies()
    if (status.state === 'running') authorizeAvidaeInitiator(event.sender.id)
    return status
  })
}
