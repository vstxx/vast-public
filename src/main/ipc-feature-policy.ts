import type { FeatureId } from '../shared/feature-gates'
import policy from '../shared/sensitive-ipc-policy.json' with { type: 'json' }
import type { BrowserSettings } from '../shared/types'

export type VaultIpcAccess = 'control' | 'unlocked' | 'fresh'

const featureByChannel = Object.freeze({ ...policy.featureByChannel }) as Readonly<Record<string, FeatureId>>
const vaultAccessByChannel = Object.freeze({ ...policy.vaultAccessByChannel }) as Readonly<Record<string, VaultIpcAccess>>
const sensitiveFamilies = ['vast:avidae:', 'vast:network:', 'vast:passwords:'] as const
const featureLabKeys: Readonly<Record<FeatureId, keyof BrowserSettings['labs'] | undefined>> = Object.freeze({
  avidae: 'avidae',
  'network-devices': 'networkDevices',
  'password-manager': 'passwordManager',
  notes: undefined,
  'advanced-notes': undefined,
  automation: 'automation',
  'session-timeline': undefined,
  'advanced-diagnostics': 'advancedDiagnostics',
  spoofing: 'spoofing',
  'advanced-import-export': undefined,
  'multiple-workspaces': undefined,
  'experimental-themes': undefined
})

export const SENSITIVE_IPC_FEATURES = featureByChannel
export const PASSWORD_VAULT_IPC_ACCESS = vaultAccessByChannel

export function requiredFeatureForIpcChannel(channel: string): FeatureId | null {
  const featureId = featureByChannel[channel]
  if (featureId) return featureId
  if (sensitiveFamilies.some((prefix) => channel.startsWith(prefix))) {
    throw new Error(`Sensitive IPC channel is missing a central feature policy: ${channel}`)
  }
  return null
}

export function vaultAccessForIpcChannel(channel: string): VaultIpcAccess | null {
  const access = vaultAccessByChannel[channel]
  if (access) return access
  if (channel.startsWith('vast:passwords:')) {
    throw new Error(`Password IPC channel is missing a central vault policy: ${channel}`)
  }
  return null
}

export function assertIpcFeatureAllowed(channel: string, settings: BrowserSettings): void {
  const featureId = requiredFeatureForIpcChannel(channel)
  if (!featureId) return
  const labKey = featureLabKeys[featureId]
  if (!labKey) throw new Error(`Sensitive IPC policy references a feature without a Labs gate: ${featureId}`)
  if (settings.labs?.[labKey] !== true) {
    throw new Error(`${featureId} is disabled in Vast Labs settings.`)
  }
}

export function assertSensitiveIpcRegistrationComplete(registeredChannels: ReadonlySet<string>): void {
  const missing = Object.keys(featureByChannel).filter((channel) => !registeredChannels.has(channel))
  if (missing.length > 0) {
    throw new Error(`Sensitive IPC policy references unregistered handlers: ${missing.join(', ')}`)
  }
  const missingVaultPolicy = Object.keys(featureByChannel)
    .filter((channel) => channel.startsWith('vast:passwords:') && !vaultAccessByChannel[channel])
  if (missingVaultPolicy.length > 0) {
    throw new Error(`Password IPC handlers are missing vault access policy: ${missingVaultPolicy.join(', ')}`)
  }
}
