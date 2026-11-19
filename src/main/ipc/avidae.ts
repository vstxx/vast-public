import type { WebContents } from 'electron/main'
import type { IpcHandle } from './registration'
import { authorizeAvidaeInitiator, revokeAvidaeInitiator } from '../avidae-auth'

// Pages that asked for Video & Audio status receive module progress pushes,
// so the installation UI does not have to poll while bytes are moving.
const moduleSubscribers = new Map<number, WebContents>()
let moduleListenerAttached = false

async function subscribeToModule(sender: WebContents): Promise<void> {
  if (!moduleSubscribers.has(sender.id)) {
    const id = sender.id
    moduleSubscribers.set(id, sender)
    sender.once('destroyed', () => moduleSubscribers.delete(id))
  }
  if (moduleListenerAttached) return
  moduleListenerAttached = true
  ;(await import('../avidae')).onAvidaeModuleChanged((module) => {
    for (const [id, target] of moduleSubscribers) {
      if (target.isDestroyed()) moduleSubscribers.delete(id)
      else target.send('vast:avidae:module-changed', module)
    }
  })
}

export function registerAvidaeIpc(handle: IpcHandle): void {
  handle('vast:avidae:status', async (event) => {
    const avidae = await import('../avidae')
    await subscribeToModule(event.sender)
    avidae.refreshAvidaeModule()
    const status = avidae.getAvidaeStatus()
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
  // No arguments: the renderer can only ask for the policy-defined module,
  // never supply a URL, path or command.
  handle('vast:avidae:install-module', async (event) => {
    await subscribeToModule(event.sender)
    return (await import('../avidae')).installAvidaeModule()
  })
  handle('vast:avidae:cancel-module-install', async () => (await import('../avidae')).cancelAvidaeModuleInstall())
}
