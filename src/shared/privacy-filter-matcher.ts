import { hostMatchesList, isThirdPartyUrl } from './url-cleaning.ts'

export interface PrivacyFilterMatchContext {
  topLevelUrl?: string
  resourceType?: string
}

interface PrivacyFilterPatternRule {
  segments: string[]
  requestDomain?: string
  documentDomains: string[]
  excludedDocumentDomains: string[]
  resourceTypes: string[]
  excludedResourceTypes: string[]
  thirdParty?: boolean
}

export interface PrivacyFilterRules {
  blockedDomains: Set<string>
  allowedDomains: Set<string>
  blockedPatterns: PrivacyFilterPatternRule[]
  allowedPatterns: PrivacyFilterPatternRule[]
}

const MAX_RULES_PER_LIST = 250_000
const MAX_URL_PATTERNS_PER_LIST = 12_000
const RESOURCE_TYPE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  document: ['mainFrame'],
  subdocument: ['subFrame'],
  stylesheet: ['stylesheet'],
  script: ['script'],
  image: ['image'],
  font: ['font'],
  object: ['object'],
  'object-subrequest': ['object'],
  xmlhttprequest: ['xhr'],
  ping: ['ping'],
  media: ['media'],
  websocket: ['webSocket'],
  other: ['other']
}
const NON_RESTRICTIVE_OPTIONS = new Set(['all', 'important'])

export function emptyPrivacyFilterRules(): PrivacyFilterRules {
  return { blockedDomains: new Set(), allowedDomains: new Set(), blockedPatterns: [], allowedPatterns: [] }
}

function normalizeDomain(value: string): string | undefined {
  const candidate = value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '')
  if (!candidate || candidate.length > 253 || candidate.includes('/') || candidate.includes(' ')) return undefined
  if (!/^[a-z0-9.-]+$/.test(candidate) || !candidate.includes('.')) return undefined
  if (candidate === 'localhost.localdomain' || candidate === 'broadcasthost') return undefined
  return candidate
}

function networkPattern(body: string): string[] | undefined {
  if (!body || body.startsWith('/') && body.endsWith('/') && body.length > 2) return undefined
  const pattern = body
    .replace(/^\|\|?/, '')
    .replace(/\|$/, '')
    .replace(/\^/g, '*')
    .toLowerCase()
  const segments = pattern.split('*').map((part) => part.trim()).filter(Boolean)
  const literalLength = segments.reduce((total, part) => total + part.length, 0)
  if (literalLength < 7 || segments.some((part) => part.includes(' ') || part.length > 2_048)) return undefined
  return segments
}

function parseDomainOption(
  value: string,
  documentDomains: string[],
  excludedDocumentDomains: string[]
): boolean {
  const entries = value.split('|').filter(Boolean)
  if (entries.length === 0) return false
  for (const entry of entries) {
    const excluded = entry.startsWith('~')
    const domain = normalizeDomain(excluded ? entry.slice(1) : entry)
    if (!domain) return false
    ;(excluded ? excludedDocumentDomains : documentDomains).push(domain)
  }
  return true
}

function parseRuleOptions(rawOptions: string | undefined): Omit<PrivacyFilterPatternRule, 'segments' | 'requestDomain'> | undefined {
  const result: Omit<PrivacyFilterPatternRule, 'segments' | 'requestDomain'> = {
    documentDomains: [],
    excludedDocumentDomains: [],
    resourceTypes: [],
    excludedResourceTypes: []
  }
  if (!rawOptions) return result

  for (const rawOption of rawOptions.split(',')) {
    const option = rawOption.trim().toLowerCase()
    if (!option) continue
    if (option.startsWith('domain=')) {
      if (!parseDomainOption(option.slice('domain='.length), result.documentDomains, result.excludedDocumentDomains)) return undefined
      continue
    }
    if (option === 'third-party' || option === '3p' || option === '~first-party' || option === '~1p') {
      result.thirdParty = true
      continue
    }
    if (option === '~third-party' || option === '~3p' || option === 'first-party' || option === '1p') {
      result.thirdParty = false
      continue
    }
    const excluded = option.startsWith('~')
    const resourceOption = excluded ? option.slice(1) : option
    const resourceTypes = RESOURCE_TYPE_OPTIONS[resourceOption]
    if (resourceTypes) {
      ;(excluded ? result.excludedResourceTypes : result.resourceTypes).push(...resourceTypes)
      continue
    }
    if (NON_RESTRICTIVE_OPTIONS.has(option)) continue

    // Redirect, CSP, header, popup and other modifier rules do not mean
    // "cancel this request". Ignoring unsupported modifiers is safer than
    // broadening them into global network blocks.
    return undefined
  }
  return result
}

function hasConstraints(options: Omit<PrivacyFilterPatternRule, 'segments' | 'requestDomain'>): boolean {
  return options.documentDomains.length > 0 ||
    options.excludedDocumentDomains.length > 0 ||
    options.resourceTypes.length > 0 ||
    options.excludedResourceTypes.length > 0 ||
    options.thirdParty !== undefined
}

export function parseNetworkFilterList(text: string): PrivacyFilterRules {
  const result = emptyPrivacyFilterRules()
  let accepted = 0
  for (const rawLine of text.split(/\r?\n/)) {
    if (accepted >= MAX_RULES_PER_LIST) break
    const line = rawLine.trim()
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[') || line.includes('##') || line.includes('#@#')) continue

    const hostFileMatch = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([^\s#]+)/)
    if (hostFileMatch) {
      const domain = normalizeDomain(hostFileMatch[1])
      if (domain) {
        result.blockedDomains.add(domain)
        accepted += 1
      }
      continue
    }

    const exception = line.startsWith('@@')
    const bodyWithOptions = exception ? line.slice(2) : line
    const optionIndex = bodyWithOptions.indexOf('$')
    const body = optionIndex >= 0 ? bodyWithOptions.slice(0, optionIndex) : bodyWithOptions
    const options = parseRuleOptions(optionIndex >= 0 ? bodyWithOptions.slice(optionIndex + 1) : undefined)
    if (!options) continue

    const targetDomains = exception ? result.allowedDomains : result.blockedDomains
    const targetPatterns = exception ? result.allowedPatterns : result.blockedPatterns
    const domainOnlyMatch = body.match(/^\|\|([a-z0-9.-]+)\^?$/i)
    if (domainOnlyMatch) {
      const domain = normalizeDomain(domainOnlyMatch[1])
      if (!domain) continue
      if (!hasConstraints(options)) targetDomains.add(domain)
      else if (targetPatterns.length < MAX_URL_PATTERNS_PER_LIST) {
        targetPatterns.push({ segments: [], requestDomain: domain, ...options })
      }
      accepted += 1
      continue
    }

    const plainDomain = optionIndex < 0 ? normalizeDomain(body) : undefined
    if (plainDomain) {
      targetDomains.add(plainDomain)
      accepted += 1
      continue
    }

    if (targetPatterns.length >= MAX_URL_PATTERNS_PER_LIST) continue
    const segments = networkPattern(body)
    if (segments) {
      targetPatterns.push({ segments, ...options })
      accepted += 1
    }
  }
  return result
}

function domainSetMatches(hostname: string, domains: ReadonlySet<string>): boolean {
  let candidate = hostname.toLowerCase()
  while (candidate) {
    if (domains.has(candidate)) return true
    const dot = candidate.indexOf('.')
    if (dot < 0) return false
    candidate = candidate.slice(dot + 1)
  }
  return false
}

function patternMatches(url: string, pattern: readonly string[]): boolean {
  let offset = 0
  for (const segment of pattern) {
    const next = url.indexOf(segment, offset)
    if (next < 0) return false
    offset = next + segment.length
  }
  return true
}

function patternRuleMatches(rawUrl: string, rule: PrivacyFilterPatternRule, context: PrivacyFilterMatchContext): boolean {
  if (rule.requestDomain && !hostMatchesList(rawUrl, [rule.requestDomain])) return false
  if (rule.segments.length > 0 && !patternMatches(rawUrl.toLowerCase(), rule.segments)) return false

  if (rule.documentDomains.length > 0) {
    if (!context.topLevelUrl || !hostMatchesList(context.topLevelUrl, rule.documentDomains)) return false
  }
  if (context.topLevelUrl && hostMatchesList(context.topLevelUrl, rule.excludedDocumentDomains)) return false
  if (rule.excludedDocumentDomains.length > 0 && !context.topLevelUrl) return false

  if (rule.thirdParty !== undefined) {
    if (!context.topLevelUrl || isThirdPartyUrl(rawUrl, context.topLevelUrl) !== rule.thirdParty) return false
  }
  if (rule.resourceTypes.length > 0) {
    if (!context.resourceType || !rule.resourceTypes.includes(context.resourceType)) return false
  }
  if (rule.excludedResourceTypes.length > 0) {
    if (!context.resourceType || rule.excludedResourceTypes.includes(context.resourceType)) return false
  }
  return true
}

function patternsMatch(rawUrl: string, patterns: readonly PrivacyFilterPatternRule[], context: PrivacyFilterMatchContext): boolean {
  return patterns.some((rule) => patternRuleMatches(rawUrl, rule, context))
}

export function privacyFilterRulesAllow(
  rules: PrivacyFilterRules,
  rawUrl: string,
  context: PrivacyFilterMatchContext = {}
): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return domainSetMatches(host, rules.allowedDomains) || patternsMatch(rawUrl, rules.allowedPatterns, context)
  } catch {
    return false
  }
}

export function privacyFilterRulesMatch(
  rules: PrivacyFilterRules,
  rawUrl: string,
  context: PrivacyFilterMatchContext = {}
): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    if (domainSetMatches(host, rules.allowedDomains) || patternsMatch(rawUrl, rules.allowedPatterns, context)) return false
    return domainSetMatches(host, rules.blockedDomains) || patternsMatch(rawUrl, rules.blockedPatterns, context)
  } catch {
    return false
  }
}
