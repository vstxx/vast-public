import { contextBridge, ipcRenderer } from 'electron'
import type { VastNativeEventName, VastNativeExtensionApi } from '../shared/extension-native-api'

type Listener = (value: never) => void
const listeners = new Map<VastNativeEventName, Set<Listener>>()

function event<T>(name: VastNativeEventName): { addListener(callback: (value: T) => void): void; removeListener(callback: (value: T) => void): void } {
  return {
    addListener(callback) {
      if (typeof callback !== 'function') throw new TypeError('Listener must be a function.')
      let bucket = listeners.get(name)
      if (!bucket) { bucket = new Set(); listeners.set(name, bucket) }
      bucket.add(callback as Listener)
    },
    removeListener(callback) { listeners.get(name)?.delete(callback as Listener) }
  }
}

ipcRenderer.on('vast-native:event', (_event, name: unknown, payload: unknown) => {
  if (typeof name !== 'string') return
  const bucket = listeners.get(name as VastNativeEventName)
  if (!bucket) return
  for (const listener of [...bucket]) {
    try { listener(payload as never) } catch { /* One extension listener must not break the others. */ }
  }
})

const call = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke('vast-native:call', method, args) as Promise<T>

const api: VastNativeExtensionApi = {
  runtime: {
    getManifest: () => call('runtime.getManifest'),
    getExtensionInfo: () => call('runtime.getExtensionInfo'),
    getPlatformInfo: () => call('runtime.getPlatformInfo')
  },
  storage: { local: {
    get: (keys) => call('storage.local.get', keys),
    set: (items) => call('storage.local.set', items),
    remove: (keys) => call('storage.local.remove', keys),
    clear: () => call('storage.local.clear')
  } },
  tabs: {
    query: (query) => call('tabs.query', query), get: (id) => call('tabs.get', id), create: (options) => call('tabs.create', options),
    update: (id, options) => call('tabs.update', id, options), reload: (id) => call('tabs.reload', id), close: (id) => call('tabs.close', id), activate: (id) => call('tabs.activate', id),
    onActivated: event('tabs.onActivated'), onCreated: event('tabs.onCreated'), onUpdated: event('tabs.onUpdated'), onRemoved: event('tabs.onRemoved')
  },
  theme: { apply: (tokens) => call('theme.apply', tokens), clear: () => call('theme.clear') },
  toolbar: { create: (action) => call('toolbar.create', action), update: (id, patch) => call('toolbar.update', id, patch), remove: (id) => call('toolbar.remove', id), onClicked: event('toolbar.onClicked') },
  sidebar: { create: (panel) => call('sidebar.create', panel), remove: (id) => call('sidebar.remove', id) },
  commands: { register: (command) => call('commands.register', command), remove: (id) => call('commands.remove', id), onCommand: event('commands.onCommand') },
  contextMenus: { create: (item) => call('contextMenus.create', item), remove: (id) => call('contextMenus.remove', id), onClicked: event('contextMenus.onClicked') },
  notifications: { create: (options) => call('notifications.create', options) }
}

contextBridge.exposeInMainWorld('vast', api)
