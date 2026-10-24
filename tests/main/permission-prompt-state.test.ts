import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { showUndecidedPermissionsAsPrompt } from '../../src/shared/permission-prompt-state.ts'

// Stand-ins for the browser objects: Electron's check reports every
// permission that is not explicitly allowed as "denied".
function installBrowserStandIns(nativeStates: Record<string, string>, notification = 'denied'): void {
  class PermissionStatus {
    readonly name: string
    constructor(name: string) { this.name = name }
    get state(): string { return nativeStates[this.name] ?? 'denied' }
  }
  class Permissions { query(descriptor: { name: string }): Promise<PermissionStatus> { return Promise.resolve(new PermissionStatus(descriptor.name)) } }
  class Notification { static get permission(): string { return notification } }
  Object.assign(globalThis, { PermissionStatus, Permissions, Notification })
}

test('undecided permissions read "prompt" and notifications "default"; decided ones are untouched', async () => {
  installBrowserStandIns({ camera: 'denied', microphone: 'denied', geolocation: 'granted', 'clipboard-read': 'denied' })
  showUndecidedPermissionsAsPrompt(['camera', 'microphone', 'notifications'])
  const permissions = new (globalThis as any).Permissions()
  assert.equal((await permissions.query({ name: 'camera' })).state, 'prompt')
  assert.equal((await permissions.query({ name: 'microphone' })).state, 'prompt')
  // Not undecided: the native reading stands (a granted or a really blocked permission).
  assert.equal((await permissions.query({ name: 'geolocation' })).state, 'granted')
  assert.equal((await permissions.query({ name: 'clipboard-read' })).state, 'denied')
  assert.equal((globalThis as any).Notification.permission, 'default')
})

test('a site blocked in Settings is not reported as undecided, so it stays "denied"', async () => {
  installBrowserStandIns({ camera: 'denied' })
  showUndecidedPermissionsAsPrompt([])
  assert.equal((await new (globalThis as any).Permissions().query({ name: 'camera' })).state, 'denied')
  assert.equal((globalThis as any).Notification.permission, 'denied')
})

test('the main process lists only permissions still set to Ask, mirroring the real handlers', () => {
  const sessions = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
  const helper = sessions.slice(sessions.indexOf('export function undecidedPermissionsForWebContents'))
  assert.match(helper, /resolveStoredPermissionPolicy\(settings, origin, kind, workspaceId\) === 'ask'/)
  assert.match(helper, /if \(\(kind === 'camera' \|\| kind === 'microphone'\) && webRtcBlocked\) return false/)
  assert.match(helper, /if \(kind === 'geolocation' && spoofing\.enabled && spoofing\.location\.mode === 'fixed'\) return false/)
  // Only for the document the guest is actually showing.
  assert.match(helper, /if \(!origin \|\| \(actualUrl && originFromPermissionUrl\(actualUrl\) !== origin\)\) return \[\]/)
  const guest = readFileSync(new URL('../../src/preload/guest.ts', import.meta.url), 'utf8')
  assert.match(guest, /contextBridge\.executeInMainWorld\(\{ func: showUndecidedPermissionsAsPrompt, args: \[documentStart\.undecidedPermissions/)
  assert.match(readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8'), /undecidedPermissions: undecidedPermissionsForWebContents/)
})
