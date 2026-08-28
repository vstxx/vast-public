import { parseVextPackage, VEXT_EXTENSION_ID, VEXT_VERSION, type ParsedVextPackage } from '../../src/shared/vext-format.ts'
import { VAST_NATIVE_API_VERSION, VAST_NATIVE_PERMISSIONS, type VastExtensionKind, type VastNativePermission } from '../../src/shared/extension-native-api.ts'
import type { ExtensionPermissionSnapshot } from '../../src/shared/extension-marketplace.ts'
import { parseExtensionMatchPattern } from '../../src/shared/extension-match-pattern.ts'
import { HttpError } from './security.ts'
import { parse } from 'acorn'

const decoder = new TextDecoder('utf-8', { fatal: true })
const safeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const safeCategory = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const forbiddenSourceFallback = /(?:\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\bWebAssembly\b|\bimportScripts\s*\(\s*["'`]https?:\/\/|\bimport\s*\(\s*["'`]https?:\/\/|\bfrom\s*["'`]https?:\/\/|\bset(?:Timeout|Interval)\s*\(\s*["'`])/i
const forbiddenRemoteHtml = /<(?:script\b[^>]*\bsrc|link\b[^>]*\b(?:href|src))\s*=\s*["']https?:\/\//i
const nativePermissionSet = new Set<string>(VAST_NATIVE_PERMISSIONS)

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, `${label} is invalid.`)
  return value.trim()
}

function optionalUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const raw = text(value, label, 2_048)
  let url: URL
  try { url = new URL(raw) } catch { throw new HttpError(400, `${label} is invalid.`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new HttpError(400, `${label} must be a safe HTTPS URL.`)
  return url.toString()
}

function strings(value: unknown, label: string, maximum = 512): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) throw new HttpError(400, `${label} are invalid.`)
  return [...new Set(value.map((entry) => text(entry, label, 4_096)))]
}

function localPath(value: unknown, label: string, files: ReadonlyMap<string, Uint8Array>): string {
  const path = text(value, label, 1_024)
  if (!files.has(path)) throw new HttpError(400, `${label} does not exist in the package.`)
  return path
}

function validateReferencedFiles(manifest: Record<string, unknown>, files: ReadonlyMap<string, Uint8Array>): void {
  if (object(manifest.background) && manifest.background.service_worker !== undefined) localPath(manifest.background.service_worker, 'Background service worker', files)
  if (object(manifest.action) && manifest.action.default_popup !== undefined) localPath(manifest.action.default_popup, 'Action popup', files)
  if (object(manifest.browser_action) && manifest.browser_action.default_popup !== undefined) localPath(manifest.browser_action.default_popup, 'Browser action popup', files)
  if (object(manifest.options_ui) && manifest.options_ui.page !== undefined) localPath(manifest.options_ui.page, 'Options page', files)
  if (manifest.options_page !== undefined) localPath(manifest.options_page, 'Options page', files)
  if (Array.isArray(manifest.content_scripts)) {
    if (manifest.content_scripts.length > 256) throw new HttpError(400, 'Content scripts are invalid.')
    for (const entry of manifest.content_scripts) {
      if (!object(entry)) throw new HttpError(400, 'Content scripts are invalid.')
      for (const path of [...strings(entry.js, 'Content script files'), ...strings(entry.css, 'Content style files')]) localPath(path, 'Content script file', files)
      const matches = strings(entry.matches, 'Content script matches')
      if (matches.length === 0 || matches.some((pattern) => !parseExtensionMatchPattern(pattern))) throw new HttpError(400, 'Content script match patterns are invalid.')
    }
  }
  if (object(manifest.vast)) {
    if (manifest.vast.background !== undefined) localPath(manifest.vast.background, 'Vast background module', files)
    if (manifest.vast.popup !== undefined) localPath(manifest.vast.popup, 'Vast popup', files)
    if (manifest.vast.options !== undefined) localPath(manifest.vast.options, 'Vast options page', files)
  }
}

interface AstNode { type: string; [key: string]: unknown }

function astNode(value: unknown): value is AstNode {
  return object(value) && typeof value.type === 'string'
}

function literalString(value: unknown): string | undefined {
  if (!astNode(value)) return undefined
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value
  if (value.type === 'TemplateLiteral' && Array.isArray(value.expressions) && value.expressions.length === 0 && Array.isArray(value.quasis)) {
    const quasi = value.quasis[0]
    if (object(quasi) && object(quasi.value) && typeof quasi.value.cooked === 'string') return quasi.value.cooked
  }
  return undefined
}

function identifierName(value: unknown): string | undefined {
  return astNode(value) && value.type === 'Identifier' && typeof value.name === 'string' ? value.name : undefined
}

function memberName(value: unknown): { object?: string; property?: string } {
  if (!astNode(value) || value.type !== 'MemberExpression') return {}
  const property = value.computed ? literalString(value.property) : identifierName(value.property)
  return { object: identifierName(value.object), property }
}

function memberPath(value: unknown): string | undefined {
  if (!astNode(value)) return undefined
  if (value.type === 'Identifier') return identifierName(value)
  if (value.type !== 'MemberExpression') return undefined
  const objectPath = memberPath(value.object)
  const property = value.computed ? literalString(value.property) : identifierName(value.property)
  return objectPath && property ? `${objectPath}.${property}` : undefined
}

function scanAstPolicy(root: AstNode, path: string): string[] {
  const violations = new Set<string>()
  const scriptVariables = new Set<string>()
  const createsScript = (value: unknown): boolean => {
    if (!astNode(value) || value.type !== 'CallExpression') return false
    const callee = memberName(value.callee)
    const args = Array.isArray(value.arguments) ? value.arguments : []
    return callee.property === 'createElement' && literalString(args[0])?.toLowerCase() === 'script'
  }
  const visit = (node: AstNode): void => {
    if (node.type === 'VariableDeclarator' && createsScript(node.init)) {
      const name = identifierName(node.id)
      if (name) scriptVariables.add(name)
    }
    if (node.type === 'Identifier' && node.name === 'WebAssembly') violations.add(`${path}: WebAssembly is prohibited`)
    if (node.type === 'ImportExpression' && /^https?:\/\//i.test(literalString(node.source) ?? '')) violations.add(`${path}: remote import`)
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && /^https?:\/\//i.test(literalString(node.source) ?? '')) violations.add(`${path}: remote module source`)
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee
      const name = identifierName(callee)
      const calleePath = memberPath(callee)
      const args = Array.isArray(node.arguments) ? node.arguments : []
      if (name === 'eval' || name === 'Function' || ['globalThis.eval', 'globalThis.Function', 'window.eval', 'window.Function', 'self.eval', 'self.Function'].includes(calleePath ?? '')) violations.add(`${path}: dynamic code constructor`)
      if ((name === 'setTimeout' || name === 'setInterval' || ['globalThis.setTimeout', 'globalThis.setInterval', 'window.setTimeout', 'window.setInterval', 'self.setTimeout', 'self.setInterval'].includes(calleePath ?? '')) && literalString(args[0]) !== undefined) violations.add(`${path}: string timer`)
      if (name === 'importScripts' && /^https?:\/\//i.test(literalString(args[0]) ?? '')) violations.add(`${path}: remote worker import`)
      if ((name === 'Worker' || name === 'SharedWorker') && /^https?:\/\//i.test(literalString(args[0]) ?? '')) violations.add(`${path}: remote worker script`)
      if (calleePath === 'navigator.serviceWorker.register' && /^https?:\/\//i.test(literalString(args[0]) ?? '')) violations.add(`${path}: remote service worker script`)
      if (calleePath === 'Reflect.construct' && identifierName(args[0]) === 'Function') violations.add(`${path}: dynamic code constructor`)
      const calleeMember = astNode(callee) && callee.type === 'MemberExpression' ? callee : undefined
      const calleeProperty = calleeMember ? (calleeMember.computed ? literalString(calleeMember.property) : identifierName(calleeMember.property)) : undefined
      if (calleeProperty === 'constructor' && astNode(calleeMember?.object) && ['FunctionExpression', 'ArrowFunctionExpression'].includes(calleeMember.object.type)) violations.add(`${path}: dynamic code constructor`)
      if (calleeProperty === 'setAttribute' && calleeMember && scriptVariables.has(identifierName(calleeMember.object) ?? '') && ['src', 'href'].includes((literalString(args[0]) ?? '').toLowerCase()) && /^https?:\/\//i.test(literalString(args[1]) ?? '')) violations.add(`${path}: remote script assignment`)
    }
    if (node.type === 'AssignmentExpression') {
      if (createsScript(node.right)) {
        const name = identifierName(node.left)
        if (name) scriptVariables.add(name)
      }
      const target = memberName(node.left)
      const left = astNode(node.left) && node.left.type === 'MemberExpression' ? node.left : undefined
      const scriptTarget = left && (scriptVariables.has(identifierName(left.object) ?? '') || createsScript(left.object))
      if (scriptTarget && (target.property === 'src' || target.property === 'href') && /^https?:\/\//i.test(literalString(node.right) ?? '')) violations.add(`${path}: remote script assignment`)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue
      if (astNode(value)) visit(value)
      else if (Array.isArray(value)) for (const child of value) if (astNode(child)) visit(child)
    }
  }
  visit(root)
  return [...violations]
}

function scanStaticPolicy(files: ReadonlyMap<string, Uint8Array>): string[] {
  const findings: string[] = []
  const review: string[] = []
  for (const [path, bytes] of files) {
    if (!/\.(?:c?js|mjs|html?)$/i.test(path)) continue
    let source: string
    try { source = decoder.decode(bytes) } catch { throw new HttpError(400, `${path} is not valid UTF-8 source code.`) }
    if (/\.(?:c?js|mjs)$/i.test(path)) {
      let program: AstNode | undefined
      try {
        program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) as unknown as AstNode
      } catch {
        try { program = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }) as unknown as AstNode } catch {
          findings.push(`${path}: JavaScript could not be parsed for static review`)
        }
      }
      if (program) findings.push(...scanAstPolicy(program, path))
      if (forbiddenSourceFallback.test(source)) findings.push(`${path}: remote or dynamic code execution`)
      const lines = source.split(/\r?\n/)
      const longest = lines.reduce((length, line) => Math.max(length, line.length), 0)
      if (source.length > 20_000 && (lines.length < 10 || longest > 10_000)) review.push(`${path}: manual review required for minified or obfuscated source`)
      if ((source.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/gi)?.length ?? 0) > 100) review.push(`${path}: manual review required for encoded source`)
    } else if (forbiddenRemoteHtml.test(source) || forbiddenSourceFallback.test(source)) findings.push(`${path}: remote or dynamic code execution`)
  }
  if (findings.length > 0) throw new HttpError(400, `Static policy validation failed (${findings.slice(0, 5).join('; ')}).`)
  return ['strict-archive', 'identity', 'manifest', 'local-resources', 'no-native-binaries', 'no-remote-or-dynamic-code', ...review]
}

export interface HubPackageSummary {
  parsed: ParsedVextPackage
  name: string
  description: string
  version: string
  kind: VastExtensionKind
  permissions: ExtensionPermissionSnapshot
  validation: string[]
}

export async function validatePublisherPackage(bytes: Uint8Array, expectedExtensionId: string, publisherId: string): Promise<HubPackageSummary> {
  let parsed: ParsedVextPackage
  try { parsed = await parseVextPackage(bytes) } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Extension package is invalid.')
  }
  if (parsed.metadata.extension_id !== expectedExtensionId) throw new HttpError(400, 'Package extension identity does not match this listing.')
  if (parsed.metadata.publisher_id !== null && parsed.metadata.publisher_id !== publisherId) throw new HttpError(400, 'Package publisher identity does not match the owner.')
  const manifestBytes = parsed.files.get('manifest.json')
  if (!manifestBytes) throw new HttpError(400, 'Package is missing manifest.json.')
  let manifest: unknown
  try { manifest = JSON.parse(decoder.decode(manifestBytes)) as unknown } catch { throw new HttpError(400, 'manifest.json is invalid.') }
  if (!object(manifest)) throw new HttpError(400, 'manifest.json is invalid.')
  const name = text(manifest.name, 'Manifest name', 128)
  const description = typeof manifest.description === 'string' ? manifest.description.trim().slice(0, 16_000) : ''
  const version = text(manifest.version, 'Manifest version', 64)
  if (!VEXT_VERSION.test(version) || version !== parsed.metadata.version) throw new HttpError(400, 'Package version is invalid or inconsistent.')
  const vast = object(manifest.vast) ? manifest.vast : undefined
  if (vast?.extension_id !== undefined && vast.extension_id !== expectedExtensionId) throw new HttpError(400, 'vast.extension_id does not match this listing.')
  const vastPermissions = strings(vast?.permissions, 'Vast permissions', 64)
  if (vast && (vast.api_version !== VAST_NATIVE_API_VERSION || vastPermissions.some((permission) => !nativePermissionSet.has(permission)))) {
    throw new HttpError(400, 'The Vast API version or native permissions are unsupported.')
  }
  const chromePermissions = strings(manifest.permissions, 'Chrome permissions')
  const contentScriptHosts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.flatMap((entry) => object(entry) ? strings(entry.matches, 'Content script matches') : [])
    : []
  const hosts = [...new Set([
    ...strings(manifest.host_permissions, 'Host permissions'),
    ...chromePermissions.filter((permission) => Boolean(parseExtensionMatchPattern(permission))),
    ...contentScriptHosts
  ])]
  if (hosts.some((permission) => !parseExtensionMatchPattern(permission))) throw new HttpError(400, 'Host permissions are invalid.')
  const hasChrome = manifest.manifest_version !== undefined || manifest.background !== undefined || manifest.content_scripts !== undefined || manifest.action !== undefined
  if (hasChrome && manifest.manifest_version !== 3) throw new HttpError(400, 'Published Chrome extensions must use Manifest V3.')
  if (!hasChrome && !vast) throw new HttpError(400, 'The package has no supported extension runtime.')
  validateReferencedFiles(manifest, parsed.files)
  const validation = scanStaticPolicy(parsed.files)
  return {
    parsed,
    name,
    description,
    version,
    kind: hasChrome && vast ? 'hybrid' : vast ? 'vast' : 'chrome',
    permissions: { chrome: chromePermissions.filter((permission) => !parseExtensionMatchPattern(permission)), hosts, vast: vastPermissions as VastNativePermission[] },
    validation
  }
}

export interface CreateExtensionInput {
  extensionId: string | null
  slug: string
  name: string
  summary: string
  description: string
  category: string
  homepage: string | null
  sourceUrl: string | null
  dataPractice: 'local-only' | 'external-processing'
  privacyPolicyUrl: string | null
  remoteServices: string
}

export interface ExtensionDataPracticeInput {
  dataPractice: 'local-only' | 'external-processing'
  privacyPolicyUrl: string | null
  remoteServices: string
}

export function parseExtensionDataPractice(value: unknown): ExtensionDataPracticeInput {
  if (!object(value)) throw new HttpError(400, 'Extension data practices are invalid.')
  const dataPractice = text(value.dataPractice, 'Data practice', 64)
  if (dataPractice !== 'local-only' && dataPractice !== 'external-processing') throw new HttpError(400, 'Data practice is invalid.')
  const privacyPolicyUrl = optionalUrl(value.privacyPolicyUrl, 'Privacy policy URL')
  if (dataPractice === 'external-processing' && !privacyPolicyUrl) throw new HttpError(400, 'A privacy policy URL is required for external data processing.')
  const remoteServices = typeof value.remoteServices === 'string' ? value.remoteServices.trim().slice(0, 2_000) : ''
  if (dataPractice === 'external-processing' && !remoteServices) throw new HttpError(400, 'Describe the remote services used by this extension.')
  if (dataPractice === 'local-only' && remoteServices) throw new HttpError(400, 'A local-only extension cannot declare remote processing services.')
  return { dataPractice, privacyPolicyUrl, remoteServices }
}

export function parseCreateExtension(value: unknown): CreateExtensionInput {
  if (!object(value)) throw new HttpError(400, 'Extension listing is invalid.')
  const slug = text(value.slug, 'Slug', 64).toLowerCase()
  const category = text(value.category, 'Category', 64).toLowerCase()
  if (!safeSlug.test(slug) || !safeCategory.test(category)) throw new HttpError(400, 'Slug or category is invalid.')
  const requestedExtensionId = value.extensionId === undefined || value.extensionId === null || value.extensionId === ''
    ? null
    : text(value.extensionId, 'Extension ID', 32).toLowerCase()
  if (requestedExtensionId !== null && !VEXT_EXTENSION_ID.test(requestedExtensionId)) throw new HttpError(400, 'Extension ID must contain exactly 32 letters from a to p.')
  const { dataPractice, privacyPolicyUrl, remoteServices } = parseExtensionDataPractice(value)
  return {
    extensionId: requestedExtensionId,
    slug,
    name: text(value.name, 'Name', 128),
    summary: text(value.summary, 'Summary', 280),
    description: text(value.description, 'Description', 16_000),
    category,
    homepage: optionalUrl(value.homepage, 'Homepage'),
    sourceUrl: optionalUrl(value.sourceUrl, 'Source URL'),
    dataPractice,
    privacyPolicyUrl,
    remoteServices
  }
}

export function assertExtensionId(value: string): void {
  if (!VEXT_EXTENSION_ID.test(value)) throw new HttpError(404, 'Extension was not found.')
}
