import type { ExtensionCompatibility } from '../../shared/types.ts'
import type { ChromeExtensionManifest, ValidatedExtensionManifest } from './extension-types.ts'

const SUPPORTED_API_PERMISSIONS = new Set([
  'storage',
  'scripting',
  'webRequest',
  'webRequestBlocking'
])
const PARTIAL_API_PERMISSIONS = new Set(['tabs', 'activeTab'])
const UNSUPPORTED_UI_KEYS = [
  'page_action',
  'side_panel',
  'chrome_url_overrides',
  'omnibox'
]

export interface ExtensionCompatibilityResult {
  compatibility: ExtensionCompatibility
  summary: string
  warnings: string[]
}

function hasContentScripts(manifest: ChromeExtensionManifest): boolean {
  return Array.isArray(manifest.content_scripts) && manifest.content_scripts.some((script) => {
    return script && typeof script === 'object' && Array.isArray(script.matches) && script.matches.length > 0
  })
}

export function analyzeExtensionCompatibility(validated: ValidatedExtensionManifest): ExtensionCompatibilityResult {
  const { manifest, permissions } = validated
  const warnings: string[] = []
  let partial = false
  const contentScripts = hasContentScripts(manifest)

  for (const permission of permissions) {
    if (SUPPORTED_API_PERMISSIONS.has(permission)) continue
    if (PARTIAL_API_PERMISSIONS.has(permission)) {
      partial = true
      warnings.push(`${permission} is only partially supported by Electron.`)
      continue
    }
    partial = true
    warnings.push(`${permission} is not in Electron's documented extension API support set.`)
  }

  if (permissions.includes('webRequest') || permissions.includes('webRequestBlocking')) {
    warnings.push('Vast network protections take precedence if they conflict with chrome.webRequest handlers.')
  }

  const uiKeys = UNSUPPORTED_UI_KEYS.filter((key) => manifest[key] !== undefined)
  if (uiKeys.length > 0) {
    partial = true
    warnings.push(`Vast does not currently provide extension UI for: ${uiKeys.join(', ')}.`)
  }

  if ((manifest.action !== undefined || manifest.browser_action !== undefined) && !validated.ui.popup) {
    partial = true
    warnings.push('Toolbar actions without a default_popup do not receive click events from the Vast extensions menu.')
  }

  if (manifest.manifest_version === 3 && manifest.background && typeof manifest.background === 'object') {
    partial = true
    warnings.push('Manifest V3 background service workers are not in Electron\'s documented supported manifest keys.')
  }

  const hasMv2Background = manifest.manifest_version === 2 && Boolean(manifest.background)
  const hasSupportedUi = Boolean(validated.ui.popup || validated.ui.options)
  if (!contentScripts && !hasMv2Background && !hasSupportedUi) {
    return {
      compatibility: 'unsupported',
      summary: 'No supported website content script or Manifest V2 background entry point was detected.',
      warnings: [...new Set(warnings)]
    }
  }

  if (partial) {
    return {
      compatibility: 'partial',
      summary: contentScripts
        ? 'Website content scripts can run, but some requested features are not fully supported.'
        : hasSupportedUi
          ? 'The extension UI is available, but some requested features are not fully supported.'
          : 'Electron can load the background extension, but some browser UI is unavailable.',
      warnings: [...new Set(warnings)]
    }
  }

  return {
    compatibility: 'compatible',
    summary: contentScripts
      ? 'Content scripts and documented Electron extension APIs were detected.'
      : hasSupportedUi
        ? 'The extension provides a supported popup or options page.'
        : 'The extension uses an Electron-supported Manifest V2 background entry point.',
    warnings: [...new Set(warnings)]
  }
}
