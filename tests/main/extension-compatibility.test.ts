import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeExtensionCompatibility, type ExtensionCapabilityFinding } from '../../src/main/extensions/extension-compatibility.ts'
import type { ChromeExtensionManifest, ValidatedExtensionManifest } from '../../src/main/extensions/extension-types.ts'

function validated(overrides: Partial<ChromeExtensionManifest> = {}): ValidatedExtensionManifest {
  const merged = [...new Set([...firstStringArray(overrides.permissions), ...firstStringArray(overrides.optional_permissions)])]
  const required = [...new Set(firstStringArray(overrides.permissions))]
  const declared = merged.filter((permission) => !permission.includes('://') && permission !== '<all_urls>')
  const requiredDeclared = required.filter((permission) => !permission.includes('://') && permission !== '<all_urls>')
  return {
    rootPath: join('fixtures', 'compatibility'),
    manifestPath: join('fixtures', 'compatibility', 'manifest.json'),
    manifest: { manifest_version: 3, name: 'Compatibility fixture', version: '1.0.0', ...overrides },
    requiredPermissions: requiredDeclared,
    permissions: declared,
    requiredHostPermissions: firstStringArray(overrides.host_permissions),
    hostPermissions: [],
    kind: 'chrome',
    ui: {}
  }
}

function firstStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function finding(capabilities: ExtensionCapabilityFinding[], id: string): ExtensionCapabilityFinding {
  const match = capabilities.find((capability) => capability.id === id)
  assert.ok(match, `expected a capability finding for ${id}`)
  return match
}

function warningsFor(capabilities: ExtensionCapabilityFinding[], id: string): string[] {
  return finding(capabilities, id).warnings ?? []
}

test('classifies a content-script extension with storage as fully compatible', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['storage'],
    host_permissions: ['http://127.0.0.1/*'],
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }]
  }))

  assert.equal(result.compatibility, 'compatible')
  assert.deepEqual(result.warnings, [])
  assert.equal(result.summary, 'Content scripts run in website tabs; all detected capabilities are supported.')
  assert.deepEqual(result.capabilities.map((capability) => capability.id).sort(), ['permission:storage', 'surface:content_scripts'])
  assert.ok(result.capabilities.every((capability) => capability.status === 'supported'))
})

test('treats an MV3 service worker as a working entry point, not an unsupported one', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['storage', 'webNavigation'],
    background: { service_worker: 'background.js' }
  }))

  const worker = finding(result.capabilities, 'background:service_worker')
  assert.equal(worker.status, 'partial')
  assert.equal(result.compatibility, 'partial')
  assert.equal(result.summary, 'The MV3 service worker runs; required APIs are missing from the current runtime.')
  const joined = result.warnings.join(' ')
  assert.match(joined, /MV3 service workers run in the current runtime/)
  assert.match(joined, /listed above as missing/)
  assert.doesNotMatch(joined, /service workers are not supported|not in Electron/i)
  assert.match(result.warnings.join(' '), /runtime\.onInstalled never fires/)
})

test('reports runtime.onInstalled gaps for any service-worker extension', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['storage'],
    background: { service_worker: 'background.js' }
  }))
  assert.equal(result.compatibility, 'partial')
  assert.deepEqual(result.warnings, ['runtime.onInstalled never fires in the current runtime, so first-run and update procedures that rely on it are skipped.'])
})

test('patched Electron plus ECE reports only capabilities proven by the production matrix', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['storage', 'alarms', 'tabs', 'webNavigation', 'webRequest', 'webRequestAuthProvider', 'contextMenus', 'notifications', 'cookies', 'permissions', 'privacy', 'downloads'],
    optional_permissions: ['bookmarks'],
    background: { service_worker: 'background.js' },
    storage: { managed_schema: 'managed.json' },
    commands: { probe: { description: 'Probe' } }
  }), 'patched-electron-ece')

  for (const permission of ['alarms', 'tabs', 'webNavigation', 'webRequest', 'webRequestAuthProvider', 'notifications', 'cookies', 'permissions']) {
    assert.equal(finding(result.capabilities, `permission:${permission}`).status, 'supported', permission)
  }
  assert.equal(finding(result.capabilities, 'background:service_worker').status, 'supported')
  assert.equal(finding(result.capabilities, 'key:storage.managed_schema').status, 'supported')
  assert.equal(finding(result.capabilities, 'permission:contextMenus').status, 'partial')
  assert.equal(finding(result.capabilities, 'permission:privacy').status, 'supported')
  assert.match(finding(result.capabilities, 'permission:privacy').detail, /three password-manager service settings/)
  assert.equal(finding(result.capabilities, 'permission:downloads').status, 'partial')
  assert.ok(!result.warnings.some((warning) => warning.includes('runtime.onInstalled never fires')))
  assert.ok(!result.capabilities.some((capability) => capability.id === 'key:optional_permissions'))
})

test('requires precise warnings for alarms creation without delivery', () => {
  const result = analyzeExtensionCompatibility(validated({ permissions: ['alarms'] }))
  assert.equal(finding(result.capabilities, 'permission:alarms').status, 'partial')
  assert.deepEqual(warningsFor(result.capabilities, 'permission:alarms'), [
    'chrome.alarms: alarms can be created, but onAlarm delivery was not observed in measured runs - including after service-worker sleep and restart - so time-based scheduling cannot be relied on.'
  ])
})

test('keeps the tabs partial classification and its event-delivery warning', () => {
  const result = analyzeExtensionCompatibility(validated({ permissions: ['tabs'] }))
  assert.equal(finding(result.capabilities, 'permission:tabs').status, 'partial')
  assert.match(result.warnings.join(' '), /chrome\.tabs is only partially supported: tabs\.query\/update\/sendMessage work, but tab events/)
  assert.match(result.warnings.join(' '), /tabs\.getCurrent\) are missing/)
})

test('warns that webRequest listeners never observe events and that Vast protections take precedence', () => {
  const result = analyzeExtensionCompatibility(validated({ permissions: ['webRequest', 'webRequestAuthProvider'] }))
  const warnings = result.warnings
  assert.ok(warnings.some((warning) => warning.includes('chrome.webRequest: listeners register but never observe network events')))
  assert.ok(warnings.some((warning) => warning.includes("Vast's own network protections take precedence")))
  assert.ok(warnings.some((warning) => warning.includes('onAuthRequired is accepted but never invoked')))
  assert.equal(finding(result.capabilities, 'permission:webRequestAuthProvider').status, 'partial')
})

test('classifies required nativeMessaging as native-messaging-required, not unsupported', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['nativeMessaging', 'storage'],
    content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }]
  }))
  const native = finding(result.capabilities, 'permission:nativeMessaging')
  assert.equal(native.status, 'native-messaging-required')
  assert.equal(result.compatibility, 'partial')
  assert.equal(result.summary, 'Content scripts run in website tabs; native messaging hosts cannot be launched.')
  assert.equal(result.warnings[0], 'chrome.nativeMessaging: the runtime cannot launch native messaging hosts, so desktop-application integrations will not connect.')
})

test('classifies optional nativeMessaging the same way and explains the optional-permission gap', () => {
  const result = analyzeExtensionCompatibility(validated({ optional_permissions: ['nativeMessaging', 'privacy'] }))
  assert.equal(finding(result.capabilities, 'permission:nativeMessaging').status, 'native-messaging-required')
  assert.ok(result.warnings.some((warning) => warning.includes('Optional-permission flows cannot complete')))
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.privacy is not provided')))
})

test('classifies nativeMessaging as supported in the approved patched ECE runtime', () => {
  const result = analyzeExtensionCompatibility(validated({ permissions: ['nativeMessaging'] }), 'patched-electron-ece')
  assert.equal(finding(result.capabilities, 'permission:nativeMessaging').status, 'supported')
  assert.ok(!result.warnings.some((warning) => warning.startsWith('chrome.nativeMessaging')))
})

test('emits individual unsupported findings for absent namespaces', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['webNavigation', 'contextMenus', 'notifications', 'cookies', 'privacy'],
    content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }]
  }))
  for (const permission of ['webNavigation', 'contextMenus', 'notifications', 'cookies', 'privacy']) {
    assert.equal(finding(result.capabilities, `permission:${permission}`).status, 'unsupported', permission)
  }
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.webNavigation is not provided')))
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.contextMenus is not provided')))
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.notifications is not provided')))
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.cookies is not provided')))
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.privacy is not provided')))
  assert.equal(result.compatibility, 'partial')
})

test('reports managed storage as unreadable when the manifest declares a managed schema', () => {
  const result = analyzeExtensionCompatibility(validated({
    storage: { managed_schema: 'managed.json' }
  }))
  assert.equal(finding(result.capabilities, 'key:storage.managed_schema').status, 'unsupported')
  assert.ok(result.warnings.some((warning) => warning.includes('chrome.storage.managed exists but every read fails')))
})

test('keeps web_accessible_resources quiet when absent and precise when declared', () => {
  const quiet = analyzeExtensionCompatibility(validated({ permissions: ['storage'] }))
  assert.ok(!quiet.warnings.some((warning) => warning.includes('web_accessible_resources')))

  const declared = analyzeExtensionCompatibility(validated({
    web_accessible_resources: [{ resources: ['page.js'], matches: ['https://*/*'] }]
  }))
  const war = finding(declared.capabilities, 'key:web_accessible_resources')
  assert.equal(war.status, 'partial')
  assert.equal(war.warnings?.length, 2)
  assert.ok(war.warnings?.[0].includes('script tag fails'))
  assert.ok(war.warnings?.[1].includes('own pages cannot fetch WAR entries'))
})

test('marks externally_connectable as partial with an enforcement caveat', () => {
  const result = analyzeExtensionCompatibility(validated({
    externally_connectable: { matches: ['https://example.com/*'] }
  }))
  assert.equal(finding(result.capabilities, 'key:externally_connectable').status, 'partial')
  assert.ok(result.warnings.some((warning) => warning.includes('enforcement of the matches list')))
})

test('experimental findings inform without downgrading an otherwise compatible manifest', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['storage'],
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
    sandbox: { pages: ['sandboxed.html'] },
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'" }
  }))
  assert.equal(finding(result.capabilities, 'key:sandbox').status, 'experimental')
  assert.equal(finding(result.capabilities, 'key:csp.wasm').status, 'experimental')
  assert.equal(result.compatibility, 'compatible')
  assert.ok(result.warnings.some((warning) => warning.includes('Sandbox pages are declared')))
  assert.ok(result.warnings.some((warning) => warning.includes('wasm-unsafe-eval')))
  assert.equal(result.summary, 'Content scripts run in website tabs; declared surfaces are unverified and may change with runtime updates.')
})

test('reports manifest commands and missing UI surfaces as unsupported', () => {
  const result = analyzeExtensionCompatibility(validated({
    commands: { 'fill-fields': { suggested_key: { default: 'Alt+Shift+U' }, description: 'Fill' } },
    side_panel: { default_path: 'panel.html' },
    omnibox: { keyword: 'kw' },
    page_action: {},
    chrome_url_overrides: { newtab: 'newtab.html' }
  }))
  assert.equal(finding(result.capabilities, 'key:commands').status, 'unsupported')
  assert.ok(result.warnings.some((warning) => warning.includes('keyboard shortcuts declared in the manifest are never delivered')))
  const ui = finding(result.capabilities, 'key:ui-surfaces')
  assert.equal(ui.status, 'unsupported')
  assert.ok(ui.label.includes('side_panel') && ui.label.includes('omnibox') && ui.label.includes('page_action') && ui.label.includes('chrome_url_overrides'))
})

test('distinguishes an action popup from a click-only action', () => {
  const popup = analyzeExtensionCompatibility(validated({ action: { default_popup: 'popup.html' } }))
  assert.equal(finding(popup.capabilities, 'surface:action.popup').status, 'partial')
  assert.ok(popup.warnings.some((warning) => warning.includes('does not render action badges')))

  const clickOnly = analyzeExtensionCompatibility(validated({ action: { default_title: 'Click only' } }))
  assert.ok(clickOnly.warnings.some((warning) => warning.includes('Toolbar actions without a default_popup do not receive click events')))
})

test('patched runtime treats its supported extension-menu popup as compatible', () => {
  const result = analyzeExtensionCompatibility(validated({
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }]
  }), 'patched-electron-ece')

  assert.equal(finding(result.capabilities, 'surface:action.popup').status, 'supported')
  assert.equal(result.compatibility, 'compatible')
})

test('patched runtime accepts panel options unless open_in_tab is explicitly required', () => {
  const panel = analyzeExtensionCompatibility(validated({ options_page: 'options.html' }), 'patched-electron-ece')
  assert.equal(finding(panel.capabilities, 'surface:options').status, 'supported')
  assert.equal(panel.compatibility, 'compatible')

  const tab = analyzeExtensionCompatibility(validated({ options_ui: { page: 'options.html', open_in_tab: true } }), 'patched-electron-ece')
  assert.equal(finding(tab.capabilities, 'surface:options').status, 'partial')
  assert.match(finding(tab.capabilities, 'surface:options').detail, /resizable extensions panel/)
  assert.ok(tab.warnings.every((warning) => !warning.includes('fixed size')))
})

test('patched runtime does not downgrade non-script web-accessible resources', () => {
  const result = analyzeExtensionCompatibility(validated({
    content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
    web_accessible_resources: [{ resources: ['assets/logo.png', 'fonts/body.woff2'], matches: ['https://example.com/*'] }]
  }), 'patched-electron-ece')

  assert.equal(finding(result.capabilities, 'key:web_accessible_resources').status, 'supported')
  assert.equal(result.compatibility, 'compatible')
})

test('classifies the options page as panel-embedded', () => {
  const result = analyzeExtensionCompatibility(validated({ options_ui: { page: 'options.html', open_in_tab: true } }))
  assert.equal(finding(result.capabilities, 'surface:options').status, 'partial')
  assert.ok(result.warnings.some((warning) => warning.includes('open_in_tab is not honored')))
})

test('flags unrecognized permissions instead of ignoring them', () => {
  const result = analyzeExtensionCompatibility(validated({ permissions: ['storage', 'madeUpPermission'] }))
  const unknown = finding(result.capabilities, 'permission:madeUpPermission')
  assert.equal(unknown.status, 'unsupported')
  assert.ok(result.warnings.some((warning) => warning.includes('"madeUpPermission" permission is not provided by the current runtime')))
})

test('classifies declared clipboard permissions as accepted but unverified, never bogus', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['clipboardRead', 'clipboardWrite', 'webRequestBlocking'],
    content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }]
  }))
  assert.equal(finding(result.capabilities, 'permission:clipboardRead').status, 'experimental')
  assert.equal(finding(result.capabilities, 'permission:clipboardWrite').status, 'experimental')
  assert.equal(finding(result.capabilities, 'permission:webRequestBlocking').status, 'supported')
  assert.ok(!result.warnings.some((warning) => warning.includes('not provided by the current runtime') && warning.includes('clipboard')))
  assert.ok(result.warnings.some((warning) => warning.includes('unverified; offscreen-document fallbacks')))
})

test('still classifies an MV2 network provider without service-worker warnings', () => {
  const result = analyzeExtensionCompatibility(validated({
    manifest_version: 2,
    vast_network: 1,
    background: { persistent: true, scripts: ['background.js'] },
    permissions: ['webRequest', 'webRequestBlocking', 'https://*/*']
  }))
  const provider = finding(result.capabilities, 'background:mv2-provider')
  assert.equal(provider.status, 'supported')
  assert.ok(!result.warnings.some((warning) => warning.includes('MV3 service workers')))
  assert.ok(!result.warnings.some((warning) => warning.includes('runtime.onInstalled never fires')))
})

test('marks a manifest without any entry point as unsupported', () => {
  const result = analyzeExtensionCompatibility(validated({ permissions: ['storage'] }))
  assert.equal(result.compatibility, 'unsupported')
  assert.equal(result.summary, 'No supported website content script, background entry point, or extension UI was detected.')
})

test('orders warnings by severity: native messaging, unsupported, partial, experimental', () => {
  const result = analyzeExtensionCompatibility(validated({
    permissions: ['nativeMessaging', 'cookies', 'alarms', 'storage'],
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
    background: { service_worker: 'background.js' },
    web_accessible_resources: [{ resources: ['page.js'], matches: ['https://*/*'] }],
    sandbox: { pages: ['sandboxed.html'] }
  }))
  const ranks = result.warnings.map((warning) =>
    warning.startsWith('chrome.nativeMessaging') ? 0
      : warning.includes('is not provided by the current runtime') ? 1
        : warning.startsWith('chrome.alarms') || warning.includes('web_accessible_resources') || warning.startsWith('MV3 service workers') || warning.startsWith('runtime.onInstalled') ? 2
          : 3)
  for (let index = 1; index < ranks.length; index += 1) {
    assert.ok(ranks[index - 1] <= ranks[index], `warning order violated at ${index}: ${result.warnings}`)
  }
  assert.equal(ranks[0], 0)
})
