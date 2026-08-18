import type { IpcHandle } from './registration'

export function registerAvidaeIpc(handle: IpcHandle): void {
  handle('vast:avidae:status', async () => (await import('../avidae')).getAvidaeStatus())
  handle('vast:avidae:start', async () => (await import('../avidae')).startAvidae())
  handle('vast:avidae:stop', async () => (await import('../avidae')).stopAvidae())
  handle('vast:avidae:install-dependencies', async () => (await import('../avidae')).installAvidaeDependencies())
}
