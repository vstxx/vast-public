import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionPermissionSnapshot } from '../../shared/extension-marketplace.ts'
import { parseExtensionMatchPattern } from '../../shared/extension-match-pattern.ts'
import { analyzeExtensionCompatibility } from './extension-compatibility.ts'
import { chromeExtensionId, resolveExtensionAssetPath, validateExtensionManifest } from './extension-manifest.ts'
import { verifyLocalChromiumStage, type LocalChromiumStage } from './local-chromium-stage.ts'
import type { ValidatedExtensionManifest } from './extension-types.ts'

export interface ValidatedLocalChromiumStage {
  validated: ValidatedExtensionManifest
  runtimeId: string
  permissions: ExtensionPermissionSnapshot
  compatibility: 'compatible' | 'partial compatibility' | 'unsupported'
  limitations: string[]
}

function validKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 40 || value.length > 32_768 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length >= 32 && decoded.toString('base64') === value
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function validateLocalAssets(root: string, manifest: Record<string, unknown>): Promise<void> {
  const background = object(manifest.background)
  const scripts = background?.scripts
  const paths = [
    ...(Array.isArray(scripts) ? scripts : []),
    ...(background?.service_worker === undefined ? [] : [background.service_worker])
  ]
  if (paths.length > 64 || paths.some((path) => typeof path !== 'string')) throw new Error('Extension background assets are invalid.')
  for (const path of paths as string[]) {
    const asset = await resolveExtensionAssetPath(root, path)
    if (!(await stat(asset)).isFile()) throw new Error('Extension background asset is not a file.')
  }
  const csp = manifest.content_security_policy
  const cspObject = object(csp)
  const policies = typeof csp === 'string' ? [csp] : cspObject ? Object.values(cspObject) : []
  if (policies.some((policy) => typeof policy !== 'string' || /https?:|\/\/|unsafe-eval|unsafe-inline|data:/i.test(policy))) {
    throw new Error('Extension content security policy is unsafe.')
  }
}

/** Validates a local, unverified Chromium copy without granting Vast-native authority. */
export async function validateLocalChromiumStage(stage: LocalChromiumStage, sourceExtensionId: string): Promise<ValidatedLocalChromiumStage> {
  if (sourceExtensionId !== stage.sourceExtensionId) throw new Error('Source extension identity changed.')
  await verifyLocalChromiumStage(stage, new AbortController().signal)
  return validateLocalChromiumRoot(stage.contentRoot, sourceExtensionId, stage.version)
}

export async function validateLocalChromiumRoot(root: string, sourceExtensionId: string, expectedVersion: string): Promise<ValidatedLocalChromiumStage> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Extension manifest is invalid.')
  if (!validKey(manifest.key)) throw new Error('Local extension has no valid public key; original ID cannot be preserved.')
  if (manifest.vast !== undefined || manifest.vast_network !== undefined || manifest.vast_document_rules !== undefined) {
    throw new Error('Imported Chromium extensions cannot request Vast-native privileges.')
  }
  const validated = await validateExtensionManifest(root, { allowOrdinaryMv2: true })
  await validateLocalAssets(root, manifest)
  if (validated.kind !== 'chrome' || validated.manifest.version !== expectedVersion) throw new Error('Local extension manifest changed during validation.')
  if (validated.hostPermissions.some((pattern) => !parseExtensionMatchPattern(pattern))) {
    throw new Error('Local extension requests invalid host access.')
  }
  const runtimeId = chromeExtensionId(root, validated.manifest.key)
  if (runtimeId !== sourceExtensionId) throw new Error('Local extension public key does not match its source ID.')
  const analysis = analyzeExtensionCompatibility(validated, 'patched-electron-ece')
  const permissions: ExtensionPermissionSnapshot = {
    chrome: [...validated.requiredPermissions],
    hosts: [...validated.requiredHostPermissions],
    vast: []
  }
  return {
    validated, runtimeId, permissions,
    compatibility: analysis.compatibility === 'partial' ? 'partial compatibility' : analysis.compatibility,
    limitations: analysis.capabilities.filter((item) => item.status !== 'supported').map((item) => `${item.id}: ${item.status}`)
  }
}
