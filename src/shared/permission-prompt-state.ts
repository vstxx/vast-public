// Electron's permission check can only answer "granted" or "denied", so a site
// permission still set to Ask reads as denied in navigator.permissions.query.
// Calling apps (Google Meet, Teams, Zoom) query first and then show their own
// "camera blocked" screen instead of asking, so Vast's prompt never appears.
// Pages are told what Chrome tells them: undecided is "prompt" (and
// Notification.permission "default"). Nothing is granted here: requests still
// go through Vast's permission prompt, and real blocks stay "denied".

export const PROMPTABLE_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications'] as const
export type PromptablePermission = typeof PROMPTABLE_PERMISSIONS[number]

/** Runs in the page's main world at document start; must stay self-contained. */
export function showUndecidedPermissionsAsPrompt(undecidedNames: string[]): void {
  try {
    const undecided = new Set(undecidedNames)
    const nativeState = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state')?.get
    const nativeQuery = Permissions.prototype.query
    if (nativeState && typeof nativeQuery === 'function') {
      const prompting = new WeakSet<object>()
      Object.defineProperty(PermissionStatus.prototype, 'state', {
        configurable: true,
        enumerable: true,
        get(this: PermissionStatus) {
          const state = nativeState.call(this)
          return state === 'denied' && prompting.has(this) ? 'prompt' : state
        }
      })
      const { query } = {
        query(this: Permissions, descriptor: PermissionDescriptor): Promise<PermissionStatus> {
          return nativeQuery.call(this, descriptor).then((status) => {
            if (descriptor && undecided.has(descriptor.name)) prompting.add(status)
            return status
          })
        }
      }
      Object.defineProperty(Permissions.prototype, 'query', { configurable: true, writable: true, value: query })
    }
    const nativePermission = undecided.has('notifications') && typeof Notification === 'function'
      ? Object.getOwnPropertyDescriptor(Notification, 'permission')?.get
      : undefined
    if (nativePermission) {
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        enumerable: true,
        get() {
          const permission = nativePermission.call(Notification)
          return permission === 'denied' ? 'default' : permission
        }
      })
    }
  } catch {
    // Leave the page's native behavior in place.
  }
}
