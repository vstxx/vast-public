import type { ExtensionCompatibility } from '../../shared/types.ts'
import { DOCUMENT_RULE_PERMISSION } from '../../shared/extension-document-capability.ts'
import type { ChromeExtensionManifest, ValidatedExtensionManifest } from './extension-types.ts'

/**
 * Capability statuses reflect measured runtime behavior (synthetic capability probes and
 * real-extension audit runs against the shipped Electron 44.3.0 runtime, 2026-09-15/16),
 * not documentation claims:
 * - supported: works without measured gaps.
 * - partial: works with specific deviations; the warning states what breaks.
 * - unsupported: the capability is absent from the runtime.
 * - experimental: measured working but outside the documented surface; may change.
 * - native-messaging-required: requires native messaging, which the runtime cannot launch.
 */
export type ExtensionCapabilityStatus =
  | 'supported'
  | 'partial'
  | 'unsupported'
  | 'experimental'
  | 'native-messaging-required'

export interface ExtensionCapabilityFinding {
  id: string
  label: string
  status: ExtensionCapabilityStatus
  detail: string
  warnings?: string[]
}

export interface ExtensionCompatibilityResult {
  compatibility: ExtensionCompatibility
  summary: string
  warnings: string[]
  capabilities: ExtensionCapabilityFinding[]
}

export type ExtensionCompatibilityProfile = 'stock-electron' | 'patched-electron-ece'

const SEVERITY: Record<ExtensionCapabilityStatus, number> = {
  'native-messaging-required': 0,
  unsupported: 1,
  partial: 2,
  experimental: 3,
  supported: 4
}

interface PermissionAssessment {
  status: ExtensionCapabilityStatus
  detail: string
  warning?: string
}

const PERMISSION_ASSESSMENTS: Record<string, PermissionAssessment> = {
  activeTab: { status: 'supported', detail: 'Passive grant; accepted without measured gaps.' },
  storage: { status: 'supported', detail: 'chrome.storage.local and chrome.storage.session work; unlimitedStorage lifts the local quota.' },
  unlimitedStorage: { status: 'supported', detail: 'Large chrome.storage.local writes are honored.' },
  scripting: { status: 'supported', detail: 'executeScript, insertCSS/removeCSS, and registerContentScripts work, including world: MAIN injections.' },
  offscreen: { status: 'supported', detail: 'Offscreen documents can be created and closed; runtime.getContexts reports them.' },
  alarms: {
    status: 'partial',
    detail: 'Alarms can be created and queried, but onAlarm delivery was not observed in measured runs, even after the worker slept and restarted.',
    warning: 'chrome.alarms: alarms can be created, but onAlarm delivery was not observed in measured runs - including after service-worker sleep and restart - so time-based scheduling cannot be relied on.'
  },
  tabs: {
    status: 'partial',
    detail: 'tabs.query/update/sendMessage work, but tab events are never delivered and methods like tabs.getCurrent are absent.',
    warning: 'chrome.tabs is only partially supported: tabs.query/update/sendMessage work, but tab events (onCreated/onUpdated/onRemoved/onActivated) are never delivered and some methods (such as tabs.getCurrent) are missing.'
  },
  idle: {
    status: 'partial',
    detail: 'idle.queryState responds, but onStateChanged delivery is unverified.',
    warning: 'chrome.idle: queryState responds, but idle state-change events are unverified; idle-triggered behavior may not fire.'
  },
  webRequest: {
    status: 'partial',
    detail: 'Listeners register but never observe network events; Vast network protections handle requests first.',
    warning: 'chrome.webRequest: listeners register but never observe network events; Vast\'s own network protections take precedence over extension handlers.'
  },
  webRequestAuthProvider: {
    status: 'partial',
    detail: 'onAuthRequired with asyncBlocking is accepted but never invoked.',
    warning: 'chrome.webRequest.onAuthRequired is accepted but never invoked, so HTTP basic-auth autofill cannot trigger.'
  },
  webRequestBlocking: { status: 'supported', detail: 'Blocking webRequest is exercised only by Vast network providers through the Vast network bridge.' },
  clipboardRead: {
    status: 'experimental',
    detail: 'The permission is accepted; clipboard reads from service workers are unverified.',
    warning: 'chrome.clipboardRead: the permission is accepted, but reading the clipboard from a service worker is unverified; offscreen-document fallbacks are the reliable path.'
  },
  clipboardWrite: {
    status: 'experimental',
    detail: 'The permission is accepted; clipboard writes from service workers are unverified.',
    warning: 'chrome.clipboardWrite: the permission is accepted, but writing the clipboard from a service worker is unverified; offscreen-document fallbacks are the reliable path.'
  },
  webNavigation: { status: 'unsupported', detail: 'The chrome.webNavigation namespace is not provided; navigation listeners and getFrame/getAllFrames are unavailable.', warning: 'chrome.webNavigation is not provided by the current runtime; navigation listeners and frame lookups are unavailable.' },
  contextMenus: { status: 'unsupported', detail: 'The chrome.contextMenus namespace is not provided.', warning: 'chrome.contextMenus is not provided by the current runtime; context-menu items cannot be created.' },
  notifications: { status: 'unsupported', detail: 'The chrome.notifications namespace is not provided.', warning: 'chrome.notifications is not provided by the current runtime; system notifications cannot be shown.' },
  cookies: { status: 'unsupported', detail: 'The chrome.cookies namespace is not provided.', warning: 'chrome.cookies is not provided by the current runtime; extensions that read or write cookies will fail.' },
  privacy: { status: 'unsupported', detail: 'The chrome.privacy namespace is not provided.', warning: 'chrome.privacy is not provided by the current runtime; browser-setting toggles are unavailable.' },
  commands: { status: 'unsupported', detail: 'The chrome.commands namespace is not provided.', warning: 'chrome.commands is not provided by the current runtime; keyboard commands cannot be received.' },
  permissions: { status: 'unsupported', detail: 'The chrome.permissions namespace is not provided.', warning: 'chrome.permissions is not provided by the current runtime; optional-permission request flows cannot complete.' },
  downloads: { status: 'unsupported', detail: 'The chrome.downloads namespace is not provided.', warning: 'chrome.downloads is not provided by the current runtime.' },
  declarativeNetRequest: { status: 'unsupported', detail: 'The chrome.declarativeNetRequest namespace is not provided.', warning: 'chrome.declarativeNetRequest is not provided by the current runtime.' },
  proxy: { status: 'unsupported', detail: 'The chrome.proxy namespace is not provided.', warning: 'chrome.proxy is not provided by the current runtime.' },
  sidePanel: { status: 'unsupported', detail: 'The chrome.sidePanel namespace is not provided; runtimes that feature-detect it will skip the side panel.', warning: 'chrome.sidePanel is not provided by the current runtime; side-panel features are skipped.' },
  nativeMessaging: {
    status: 'native-messaging-required',
    detail: 'The runtime cannot launch native messaging hosts.',
    warning: 'chrome.nativeMessaging: the runtime cannot launch native messaging hosts, so desktop-application integrations will not connect.'
  }
}

const PATCHED_ECE_PERMISSION_ASSESSMENTS: Record<string, PermissionAssessment> = {
  nativeMessaging: {
    status: 'supported',
    detail: 'The approved ECE runtime launches allowlisted Chromium Native Messaging hosts with bounded UTF-8 framing and lifecycle error propagation.'
  },
  alarms: { status: 'supported', detail: 'Alarms persist, wake suspended MV3 workers, and dispatch onAlarm exactly once.' },
  tabs: { status: 'supported', detail: 'ECE maps Vast tabs and windows to Chrome tab methods and lifecycle events.' },
  webRequest: { status: 'supported', detail: 'Extension listeners share one native request pipeline with authoritative Vast security policy.' },
  webRequestAuthProvider: { status: 'supported', detail: 'onAuthRequired supports async extension credentials when Vast does not cancel or provide credentials.' },
  webNavigation: { status: 'supported', detail: 'Navigation events and frame lookups are provided by ECE for Vast tabs.' },
  contextMenus: {
    status: 'partial',
    detail: 'Creation, removal, clicks, and visibility work; contextMenus.update remains unavailable.',
    warning: 'chrome.contextMenus.update is unavailable; extensions that dynamically edit an existing menu item must recreate it.'
  },
  notifications: { status: 'supported', detail: 'Notification creation and lifecycle are provided by ECE.' },
  cookies: { status: 'supported', detail: 'Cookie reads and writes use the extension workspace session.' },
  privacy: {
    status: 'supported',
    detail: 'The three password-manager service settings are implemented: passwordSavingEnabled, autofillAddressEnabled, and autofillCreditCardEnabled. Other privacy settings remain unavailable.'
  },
  commands: {
    status: 'partial',
    detail: 'Declared commands can be enumerated; end-to-end shortcut dispatch is not yet verified.',
    warning: 'chrome.commands can enumerate declared commands, but keyboard shortcut dispatch is not yet verified.'
  },
  permissions: { status: 'supported', detail: 'Manifest-declared optional grants persist and add/remove events are scoped to the requesting extension.' },
  downloads: {
    status: 'partial',
    detail: 'Electron exposes the namespace, but the production compatibility matrix does not yet validate download methods and events.',
    warning: 'chrome.downloads is exposed but not covered by the production compatibility matrix.'
  }
}

function permissionFinding(permission: string, profile: ExtensionCompatibilityProfile): ExtensionCapabilityFinding {
  const assessment = profile === 'patched-electron-ece'
    ? PATCHED_ECE_PERMISSION_ASSESSMENTS[permission] ?? PERMISSION_ASSESSMENTS[permission]
    : PERMISSION_ASSESSMENTS[permission]
  if (assessment) {
    return {
      id: `permission:${permission}`,
      label: `chrome.${permission}`,
      status: assessment.status,
      detail: assessment.detail,
      ...(assessment.warning ? { warnings: [assessment.warning] } : {})
    }
  }
  return {
    id: `permission:${permission}`,
    label: `chrome.${permission}`,
    status: 'unsupported',
    detail: `"${permission}" is not a capability the current runtime provides.`,
    warnings: [`The "${permission}" permission is not provided by the current runtime and grants nothing.`]
  }
}

function firstStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function collectPermissionFindings(permissions: readonly string[], profile: ExtensionCompatibilityProfile): ExtensionCapabilityFinding[] {
  const declared = [...new Set(permissions.filter((permission) =>
    !permission.includes('://') && permission !== '<all_urls>' && permission !== DOCUMENT_RULE_PERMISSION))]
  return declared.map((permission) => permissionFinding(permission, profile))
}

function collectKeyFindings(manifest: ChromeExtensionManifest, profile: ExtensionCompatibilityProfile): ExtensionCapabilityFinding[] {
  const findings: ExtensionCapabilityFinding[] = []

  if (manifest.externally_connectable) {
    findings.push({
      id: 'key:externally_connectable',
      label: 'externally_connectable',
      status: 'partial',
      detail: 'runtime.onMessageExternal delivery from listed origins works; enforcement of the matches list is unverified.',
      warnings: ['externally_connectable: message delivery from listed web origins works, but enforcement of the matches list against foreign origins is unverified.']
    })
  }

  if (manifest.storage && typeof manifest.storage === 'object' && 'managed_schema' in manifest.storage) {
    findings.push({
      id: 'key:storage.managed_schema',
      label: 'storage.managed_schema',
      status: profile === 'patched-electron-ece' ? 'supported' : 'unsupported',
      detail: profile === 'patched-electron-ece' ? 'chrome.storage.managed reads complete successfully.' : 'chrome.storage.managed exists but every read fails.',
      ...(profile === 'patched-electron-ece' ? {} : { warnings: ['chrome.storage.managed exists but every read fails in the current runtime; policy-provided configuration cannot be loaded.'] })
    })
  }

  if (manifest.web_accessible_resources !== undefined) {
    const resourceEntries = Array.isArray(manifest.web_accessible_resources) ? manifest.web_accessible_resources : []
    const resources = resourceEntries.flatMap((entry) =>
      typeof entry === 'string'
        ? [entry]
        : entry && typeof entry === 'object'
          ? firstStringArray((entry as Record<string, unknown>).resources)
          : [])
    const requiresScriptInjection = resources.some((resource) => /\.(?:m?js)(?:$|[?#])/i.test(resource))
    const fullySupported = profile === 'patched-electron-ece' && !requiresScriptInjection
    findings.push({
      id: 'key:web_accessible_resources',
      label: 'web_accessible_resources',
      status: fullySupported ? 'supported' : 'partial',
      detail: fullySupported
        ? 'Declared non-script resources load from matching website contexts.'
        : 'Fetches from content scripts, iframe loads, and use_dynamic_url resources work; script-tag injection of extension .js files fails.',
      ...(fullySupported ? {} : {
        warnings: [
          'web_accessible_resources: loading extension scripts into the page via a script tag fails, so page-world injection through web-accessible resources does not work.',
          'web_accessible_resources: the extension\'s own pages cannot fetch WAR entries whose matches exclude the extension origin; fetches from content scripts and iframe loads work.'
        ]
      })
    })
  }

  if (manifest.sandbox !== undefined) {
    findings.push({
      id: 'key:sandbox',
      label: 'sandbox pages',
      status: 'experimental',
      detail: 'Declared sandbox pages sit outside the documented runtime surface; behavior is unverified.',
      warnings: ['Sandbox pages are declared in the manifest but are an unverified surface in the current runtime.']
    })
  }

  const csp = manifest.content_security_policy
  const extensionPagesCsp = csp && typeof csp === 'object' ? String((csp as Record<string, unknown>).extension_pages ?? '') : typeof csp === 'string' ? csp : ''
  if (extensionPagesCsp.includes('wasm-unsafe-eval')) {
    findings.push({
      id: 'key:csp.wasm',
      label: 'WebAssembly (wasm-unsafe-eval)',
      status: 'experimental',
      detail: 'WebAssembly in extension pages is unverified in the current runtime.',
      warnings: ['The manifest enables WebAssembly via wasm-unsafe-eval; WebAssembly execution in extension pages is unverified in the current runtime.']
    })
  }

  if (manifest.commands !== undefined) {
    findings.push({
      id: 'key:commands',
      label: 'commands',
      status: profile === 'patched-electron-ece' ? 'partial' : 'unsupported',
      detail: profile === 'patched-electron-ece' ? 'Declared commands can be enumerated; shortcut dispatch is unverified.' : 'The chrome.commands namespace is not provided and Vast delivers no keyboard shortcuts to Chrome-runtime extensions.',
      warnings: [profile === 'patched-electron-ece' ? 'commands: declared commands can be enumerated, but keyboard shortcut dispatch is not yet verified.' : 'commands: keyboard shortcuts declared in the manifest are never delivered; the runtime provides no commands API or shortcut dispatch.']
    })
  }

  if (firstStringArray(manifest.optional_permissions).length > 0 && !firstStringArray(manifest.permissions).includes('permissions')) {
    if (profile === 'stock-electron') {
      findings.push({
        id: 'key:optional_permissions',
        label: 'optional_permissions',
        status: 'unsupported',
        detail: 'Optional-permission flows cannot complete: the runtime provides no chrome.permissions request/contains API and no permission events.',
        warnings: ['Optional-permission flows cannot complete: the runtime provides no chrome.permissions request/contains API and no permission events.']
      })
    }
  }

  const missingUiKeys = (['side_panel', 'page_action', 'omnibox', 'chrome_url_overrides'] as const)
    .filter((key) => manifest[key] !== undefined)
  if (missingUiKeys.length > 0) {
    findings.push({
      id: 'key:ui-surfaces',
      label: missingUiKeys.join(', '),
      status: 'unsupported',
      detail: 'Vast provides no surface for these manifest keys.',
      warnings: [`Vast does not currently provide extension UI for: ${missingUiKeys.join(', ')}.`]
    })
  }

  const action = manifest.action ?? manifest.browser_action
  if (action && typeof action === 'object') {
    const hasPopup = typeof (action as Record<string, unknown>).default_popup === 'string'
    findings.push(hasPopup
      ? profile === 'patched-electron-ece' ? {
          id: 'surface:action.popup',
          label: 'action popup',
          status: 'supported',
          detail: 'The popup opens in the Vast extensions menu on website tabs.'
        } : {
          id: 'surface:action.popup',
          label: 'action popup',
          status: 'partial',
          detail: 'The popup opens as a panel inside the extensions menu on website tabs; internal Vast pages stay isolated. Badges are not rendered and the popup is not anchored to a toolbar button.',
          warnings: ['The action popup opens as a panel in the extensions menu on website tabs; Vast does not expose internal pages to Chrome extensions, does not render action badges, and does not anchor the popup to a toolbar button.']
        }
      : {
          id: 'surface:action',
          label: 'action',
          status: 'partial',
          detail: 'Toolbar actions without a default_popup do not receive click events from the extensions menu.',
          warnings: ['Toolbar actions without a default_popup do not receive click events from the Vast extensions menu.']
        })
  }

  const optionsUi = manifest.options_ui && typeof manifest.options_ui === 'object' ? manifest.options_ui : undefined
  const optionsPage = (optionsUi && typeof (optionsUi as Record<string, unknown>).page === 'string')
    || typeof manifest.options_page === 'string'
  if (optionsPage) {
    const requiresTab = optionsUi?.open_in_tab === true
    const fullySupported = profile === 'patched-electron-ece' && !requiresTab
    findings.push({
      id: 'surface:options',
      label: 'options page',
      status: fullySupported ? 'supported' : 'partial',
      detail: fullySupported
        ? 'The options page opens inside the Vast extensions panel.'
        : 'The options page opens inside the resizable extensions panel; open_in_tab is not honored.',
      ...(fullySupported ? {} : { warnings: ['The options page opens inside the resizable extensions panel; open_in_tab is not honored.'] })
    })
  }

  return findings
}

function collectEntryPointFindings(manifest: ChromeExtensionManifest, profile: ExtensionCompatibilityProfile): ExtensionCapabilityFinding[] {
  const findings: ExtensionCapabilityFinding[] = []

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  if (contentScripts.some((entry) => entry && typeof entry === 'object' && firstStringArray((entry as Record<string, unknown>).matches).length > 0)) {
    const usesMainWorld = contentScripts.some((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).world === 'MAIN')
    findings.push({
      id: 'surface:content_scripts',
      label: 'content scripts',
      status: 'supported',
      detail: usesMainWorld
        ? 'Content scripts inject into website tabs, iframes, and Vast webview guests; manifest world: MAIN is honored.'
        : 'Content scripts inject into website tabs, iframes, and Vast webview guests.'
    })
  }

  const background = manifest.background
  if (background && typeof background === 'object' && typeof (background as Record<string, unknown>).service_worker === 'string') {
    findings.push({
      id: 'background:service_worker',
      label: 'MV3 service worker',
      status: profile === 'patched-electron-ece' ? 'supported' : 'partial',
      detail: profile === 'patched-electron-ece'
        ? 'Service workers start, suspend, wake on events and alarms, and receive install/update/startup lifecycle events.'
        : 'Service workers start, idle, and wake on runtime messages; registration fails only if startup code accesses capabilities the runtime does not provide.'
    })
  } else if (background && typeof background === 'object' && Array.isArray((background as Record<string, unknown>).scripts)) {
    findings.push({
      id: 'background:mv2-provider',
      label: 'MV2 background page',
      status: 'supported',
      detail: 'Runs as a persistent background page delivered through the Vast network bridge.'
    })
  }

  return findings
}

function hasSupportedEntryPoint(findings: ExtensionCapabilityFinding[]): boolean {
  return findings.some((finding) =>
    finding.id === 'surface:content_scripts' ||
    finding.id.startsWith('background:') ||
    finding.id === 'surface:action.popup' ||
    finding.id === 'surface:options')
}

function buildWarnings(findings: ExtensionCapabilityFinding[]): string[] {
  return [...findings]
    .sort((left, right) => SEVERITY[left.status] - SEVERITY[right.status])
    .flatMap((finding) => finding.warnings ?? [])
}

function buildSummary(findings: ExtensionCapabilityFinding[], hasEntryPoint: boolean): string {
  if (!hasEntryPoint) {
    return 'No supported website content script, background entry point, or extension UI was detected.'
  }
  const opening = findings.some((finding) => finding.id === 'surface:content_scripts')
    ? 'Content scripts run in website tabs'
    : findings.some((finding) => finding.id === 'background:mv2-provider')
      ? 'The extension runs as a Vast network provider'
      : findings.some((finding) => finding.id === 'background:service_worker')
        ? 'The MV3 service worker runs'
        : 'The extension UI is available'
  const closing = findings.some((finding) => finding.status === 'native-messaging-required')
    ? 'native messaging hosts cannot be launched.'
    : findings.some((finding) => finding.status === 'unsupported')
      ? 'required APIs are missing from the current runtime.'
      : findings.some((finding) => finding.status === 'partial')
        ? 'some requested features have measured gaps.'
        : findings.some((finding) => finding.status === 'experimental')
          ? 'declared surfaces are unverified and may change with runtime updates.'
          : 'all detected capabilities are supported.'
  return `${opening}; ${closing}`
}

export function analyzeExtensionCompatibility(
  validated: ValidatedExtensionManifest,
  profile: ExtensionCompatibilityProfile = 'stock-electron'
): ExtensionCompatibilityResult {
  const findings = [
    ...collectPermissionFindings(validated.permissions, profile),
    ...collectKeyFindings(validated.manifest, profile),
    ...collectEntryPointFindings(validated.manifest, profile)
  ]

  const serviceWorker = findings.find((finding) => finding.id === 'background:service_worker')
  if (serviceWorker && profile === 'stock-electron') {
    const notes: string[] = []
    if (findings.some((finding) => finding.status === 'unsupported' || finding.status === 'native-messaging-required')) {
      notes.push('MV3 service workers run in the current runtime, but the worker fails to register if its startup code accesses any capability listed above as missing; content scripts and extension pages still load.')
    }
    notes.push('runtime.onInstalled never fires in the current runtime, so first-run and update procedures that rely on it are skipped.')
    serviceWorker.warnings = notes
  }

  const hasEntryPoint = hasSupportedEntryPoint(findings)
  const downgraded = findings.some((finding) =>
    finding.status === 'partial' || finding.status === 'unsupported' || finding.status === 'native-messaging-required')

  return {
    compatibility: !hasEntryPoint ? 'unsupported' : downgraded ? 'partial' : 'compatible',
    summary: buildSummary(findings, hasEntryPoint),
    warnings: buildWarnings(findings),
    capabilities: findings
  }
}
