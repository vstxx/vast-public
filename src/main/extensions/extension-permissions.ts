import type { VastNativePermission } from '../../shared/extension-native-api.ts'

export function effectiveNativeGrants(requested: readonly VastNativePermission[], granted: readonly VastNativePermission[]): VastNativePermission[] {
  const grantSet = new Set(granted)
  return requested.filter((permission, index) => requested.indexOf(permission) === index && grantSet.has(permission))
}

export function hasPendingNativePermissions(requested: readonly VastNativePermission[], granted: readonly VastNativePermission[]): boolean {
  const effective = new Set(effectiveNativeGrants(requested, granted))
  return requested.some((permission) => !effective.has(permission))
}
