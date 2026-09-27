/** Shared by local installation and Hub package validation. */
export const DOCUMENT_RULE_PERMISSION = 'vast.documentRules'
export function documentRulesManifestError(manifest: Record<string, unknown>): string | undefined {
  if (manifest.vast_document_rules === undefined) return
  const background = manifest.background as { persistent?: unknown; scripts?: unknown; page?: unknown } | undefined
  const permissions = manifest.permissions
  if (manifest.vast_document_rules !== 1 || manifest.vast_network !== 1 || manifest.manifest_version !== 2 ||
    !background || background.persistent !== true || (!Array.isArray(background.scripts) && typeof background.page !== 'string') ||
    !Array.isArray(permissions) || !permissions.includes('webRequest') || !permissions.includes('webRequestBlocking')) {
    return 'Document rules require API version 1, an authorized network provider and an explicit persistent Manifest V2 background page.'
  }
}
