import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_SESSION_TIMELINE_URL
} from './constants'
import type { BrowserSettings } from './types'
import { resolveLocalFeatureState, type LocalFeatureStateKind } from './local-feature-state'

export const VastFeatures = {
  Avidae: 'avidae',
  NetworkDevices: 'network-devices',
  PasswordManager: 'password-manager',
  Notes: 'notes',
  AdvancedNotes: 'advanced-notes',
  Automation: 'automation',
  SessionTimeline: 'session-timeline',
  AdvancedDiagnostics: 'advanced-diagnostics',
  Spoofing: 'spoofing',
  AdvancedImportExport: 'advanced-import-export',
  MultipleWorkspaces: 'multiple-workspaces',
  ExperimentalThemes: 'experimental-themes'
} as const

export type FeatureId = (typeof VastFeatures)[keyof typeof VastFeatures]
export type FeatureStateKind = LocalFeatureStateKind

export interface FeatureGate {
  id: FeatureId
  label: string
  description?: string
  lab?: keyof BrowserSettings['labs']
  internalUrl?: string
  comingSoon?: boolean
}

export interface FeatureState extends FeatureGate {
  state: FeatureStateKind
  available: boolean
  message: string
}

export interface FeatureGateContext {
  settings: BrowserSettings
}

export const FEATURE_REGISTRY: Record<FeatureId, FeatureGate> = {
  [VastFeatures.Avidae]: {
    id: VastFeatures.Avidae,
    label: 'Video & Audio',
    description: 'Built-in media tools for local recording, conversion, trimming, and downloads.',
    lab: 'avidae',
    internalUrl: INTERNAL_AVIDAE_URL
  },
  [VastFeatures.NetworkDevices]: {
    id: VastFeatures.NetworkDevices,
    label: 'Network Devices',
    description: 'Discover local devices, cast targets, routers, printers, and private web panels.',
    lab: 'networkDevices',
    internalUrl: INTERNAL_NETWORK_URL
  },
  [VastFeatures.PasswordManager]: {
    id: VastFeatures.PasswordManager,
    label: 'Password Manager',
    description: 'Local encrypted password vault, CSV import/export, and autofill helpers.',
    lab: 'passwordManager',
    internalUrl: INTERNAL_PASSWORDS_URL
  },
  [VastFeatures.Notes]: {
    id: VastFeatures.Notes,
    label: 'Notes',
    description: 'Simple local note creation, editing, reading, and deletion.',
    internalUrl: INTERNAL_NOTES_URL
  },
  [VastFeatures.AdvancedNotes]: {
    id: VastFeatures.AdvancedNotes,
    label: 'Advanced notes',
    description: 'Page-linked notes, quote capture, tags, pinning, favorites, archives, and advanced note workflows.'
  },
  [VastFeatures.Automation]: {
    id: VastFeatures.Automation,
    label: 'Automation',
    description: 'Create and run local Vast macros.',
    lab: 'automation',
    internalUrl: INTERNAL_AUTOMATION_URL
  },
  [VastFeatures.SessionTimeline]: {
    id: VastFeatures.SessionTimeline,
    label: 'Session Timeline',
    description: 'Save, review, and restore workspace snapshots.',
    internalUrl: INTERNAL_SESSION_TIMELINE_URL
  },
  [VastFeatures.AdvancedDiagnostics]: {
    id: VastFeatures.AdvancedDiagnostics,
    label: 'Advanced diagnostics',
    description: 'Deeper local diagnostics and site data views.',
    lab: 'advancedDiagnostics',
    internalUrl: INTERNAL_DIAGNOSTICS_URL
  },
  [VastFeatures.Spoofing]: {
    id: VastFeatures.Spoofing,
    label: 'Best-effort spoofing tools',
    description: 'Best-effort user-agent, locale, timezone, hardware, and location privacy controls.',
    lab: 'spoofing'
  },
  [VastFeatures.AdvancedImportExport]: {
    id: VastFeatures.AdvancedImportExport,
    label: 'Advanced import/export',
    description: 'Advanced local import and export workflows.'
  },
  [VastFeatures.MultipleWorkspaces]: {
    id: VastFeatures.MultipleWorkspaces,
    label: 'Multiple workspaces',
    description: 'Expanded workspace organization.'
  },
  [VastFeatures.ExperimentalThemes]: {
    id: VastFeatures.ExperimentalThemes,
    label: 'Experimental themes',
    description: 'Experimental themes are not active in this build.',
    comingSoon: true
  }
}

export const FEATURE_LIST: FeatureGate[] = Object.values(FEATURE_REGISTRY)

export function featureById(id: FeatureId): FeatureGate {
  return FEATURE_REGISTRY[id]
}

export function featureGateForInternalUrl(url: string): FeatureGate | null {
  if (url === INTERNAL_AVIDAE_URL) return FEATURE_REGISTRY[VastFeatures.Avidae]
  if (url === INTERNAL_NETWORK_URL) return FEATURE_REGISTRY[VastFeatures.NetworkDevices]
  if (url === INTERNAL_PASSWORDS_URL) return FEATURE_REGISTRY[VastFeatures.PasswordManager]
  if (url === INTERNAL_NOTES_URL) return FEATURE_REGISTRY[VastFeatures.Notes]
  if (url === INTERNAL_AUTOMATION_URL) return FEATURE_REGISTRY[VastFeatures.Automation]
  if (url === INTERNAL_SESSION_TIMELINE_URL) return FEATURE_REGISTRY[VastFeatures.SessionTimeline]
  if (url === INTERNAL_DIAGNOSTICS_URL) return FEATURE_REGISTRY[VastFeatures.AdvancedDiagnostics]
  return null
}

export function labsFeatureEnabled(settings: BrowserSettings, gate: FeatureGate): boolean {
  if (!gate.lab) return true
  return Boolean(settings.labs?.enabled && settings.labs[gate.lab])
}

export function getFeatureState(featureId: FeatureId, context: FeatureGateContext): FeatureState {
  const gate = featureById(featureId)
  const state = resolveLocalFeatureState({
    comingSoon: gate.comingSoon === true,
    labRequired: Boolean(gate.lab),
    labsEnabled: context.settings.labs?.enabled === true,
    featureEnabled: gate.lab ? context.settings.labs[gate.lab] === true : true
  })
  if (state === 'ComingSoon') {
    return {
      ...gate,
      state: 'ComingSoon',
      available: false,
      message: `${gate.label} is not available in this build yet.`
    }
  }

  if (state === 'DisabledByFlag') {
    return {
      ...gate,
      state: 'DisabledByFlag',
      available: false,
      message: `${gate.label} is disabled in Vast Labs settings.`
    }
  }

  return {
    ...gate,
    state: 'Available',
    available: true,
    message: `${gate.label} is available.`
  }
}

export function getFeatureStateForGate(gate: FeatureGate, context: FeatureGateContext): FeatureState {
  return getFeatureState(gate.id, context)
}

export function canUseFeature(featureId: FeatureId, context: FeatureGateContext): boolean {
  return getFeatureState(featureId, context).available
}
