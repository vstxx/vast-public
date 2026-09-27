import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { resolve } from 'node:path'
import { Resources, Request } from '@ghostery/adblocker'
import { initialize, documentRules } from '../../resources/first-party-extensions/adblocker-for-vast/src/engine.ts'
import { defaults, migrateSettings, LISTS } from '../../resources/first-party-extensions/adblocker-for-vast/src/settings.ts'
import { parseSupported, assembleScriptlets } from '../../resources/first-party-extensions/adblocker-for-vast/src/rules.ts'
import { createDocumentRuleStore, documentRuleUrl, sanitizeDocumentRules, DOCUMENT_RULE_TTL, DOCUMENT_RULE_MAX_BYTES } from '../../src/main/extensions/extension-document-rules.ts'
import { validateExtensionManifest } from '../../src/main/extensions/extension-manifest.ts'
import { permissionEscalation, hasPermissionEscalation } from '../../src/shared/extension-marketplace.ts'
import { documentRulesManifestError } from '../../src/shared/extension-document-capability.ts'
const root = 'resources/first-party-extensions/adblocker-for-vast/assets/'
const resources = { safe: await readFile(root + 'resources-safe.json', 'utf8'), trusted: await readFile(root + 'resources-trusted.json', 'utf8') }
const safe = Resources.parse(resources.safe, { checksum: 'safe' }), trusted = Resources.parse(resources.trusted, { checksum: 'trusted' })
const filler = Array.from({ length: 12 }, (_, i) => `||ad${i}.example^`).join('\n')
const compile = (customFilters: string, source = '', id = 'ublock') => initialize({ settings: { ...defaults(), lists: source ? [id] : [], customFilters }, lists: { [id]: { text: filler + '\n' + source, updatedAt: 0, checkedAt: 0 } }, resources })
function page() {
  const context = vm.createContext({ Request, Response, EventTarget, XMLHttpRequest: class {}, fetch, console, document: { readyState: 'complete', currentScript: null }, location: new URL('https://example.com/'), addEventListener() {}, removeEventListener() {} })
  vm.runInContext('globalThis.self=globalThis;globalThis.window=globalThis', context)
  return context
}
test('schema 1 migration preserves selections, rules, allowlists and disabled state', () => {
  const old = { ...defaults(), schema: 1, enabled: false, lists: ['easylist'], allowlist: ['EXAMPLE.com'], cosmeticAllowlist: ['a.example'], customFilters: '||ads.example^' }
  const next = migrateSettings(old)
  assert.equal(next.schema, 2); assert.equal(next.enabled, false); assert.deepEqual(next.lists, old.lists)
  assert.equal(next.customFilters, old.customFilters); assert.deepEqual(next.allowlist, ['example.com']); assert.deepEqual(next.cosmeticAllowlist, old.cosmeticAllowlist)
  assert.equal(next.advancedProtection, true); assert.deepEqual(next.advancedAllowlist, [])
  assert.equal(LISTS.filter(list => list.default).length, 6)
})
test('safe set-constant executes; argument data cannot escape into JavaScript', async () => {
  const state = await compile('example.com##+js(set-constant, adEnabled, false)'), context = page()
  for (const script of documentRules(state, 'https://example.com/')) vm.runInContext(script, context)
  assert.equal(context.adEnabled, false)
  const parsed = parseSupported('example.com##+js(set-constant, x, `);globalThis.escaped=true;//)', safe)
  const code = assembleScriptlets(parsed.cosmeticFilters, safe)
  if (code) vm.runInContext(code, context)
  assert.equal(context.escaped, undefined)
})
test('scriptlet exceptions including aliases and blanket unhides suppress execution', async () => {
  for (const exception of ['example.com#@#+js(set-constant, adEnabled, false)', 'example.com#@#+js(set, adEnabled, false)', 'example.com#@#+js()']) assert.deepEqual(documentRules(await compile('example.com##+js(set-constant, adEnabled, false)\n' + exception), 'https://example.com/'), [])
})
test('missing, malformed and trusted custom rules are rejected without replacing working engine', async () => {
  const state = await compile('||ads.example^')
  for (const rule of ['example.com##+js(missing-resource, x)', 'example.com##+js(set-constant', 'example.com##+js(trusted-set-constant, x, true)', 'example.com##+js(trusted-replace-fetch-response, x, y)', 'example.com##^script:has-text(ad)']) await assert.rejects(compile(rule), /invalid|forbidden/)
  assert.equal(state.engine.match(Request.fromRawDetails({ url: 'https://ads.example/ad', sourceUrl: 'https://example.com', type: 'script' })).match, true)
})
test('trusted scriptlets require a code-owned approved list ID, never list directives', async () => {
  const rule = 'example.com##+js(trusted-set-constant, approved, true)', state = await compile('', rule), context = page()
  documentRules(state, 'https://example.com/').forEach(script => vm.runInContext(script, context))
  assert.equal(context.approved, true)
  for (const id of ['easylist', 'easyprivacy', 'cookies']) {
    const ordinary = await compile('', '!#trusted\n! trusted=true\n' + rule, id)
    assert.deepEqual(documentRules(ordinary, 'https://example.com/'), [])
    assert.ok(ordinary.cache.report[id].unsupported > 0)
  }
  assert.ok(!safe.scriptlets.some(entry => entry.requiresTrust)); assert.ok(trusted.scriptlets.some(entry => entry.requiresTrust))
  assert.equal(safe.getScriptlet('trusted-set-constant'), undefined)
})
test('extended cosmetics and exceptions produce engine ASTs; HTML stays disabled', async () => {
  const state = await compile('example.com##.sponsor:has-text(Promoted)\nexample.com##.keep:has-text(Promoted)\nexample.com#@#.keep:has-text(Promoted)')
  const result = state.engine.getCosmeticsFilters({ url: 'https://example.com/', hostname: 'example.com', domain: 'example.com' })
  assert.equal(result.extended.length, 1); assert.ok(result.extended[0].ast)
  assert.equal(state.engine.config.enableHtmlFiltering, false)
})
test('both compiled domains restore exactly the same document rules', async () => {
  const settings = { ...defaults(), lists: [], customFilters: 'example.com##+js(set, cacheFixture, true)' }
  const first = await initialize({ settings, lists: {}, resources })
  const second = await initialize({ settings, lists: {}, resources, cached: first.cache })
  assert.equal(second.cache.cacheHit, true)
  assert.deepEqual(documentRules(first, 'https://example.com/'), documentRules(second, 'https://example.com/'))
})
test('pending document rules are one-shot, generation/URL-bound and expire', () => {
  let now = 0; const store = createDocumentRuleStore(() => now)
  const old = store.begin(10, 'https://example.com/a'), next = store.begin(10, 'https://example.com/b')
  assert.equal(store.stage(10, old, 'https://example.com/a', 1, ['old']), false)
  assert.equal(store.stage(10, next, 'https://example.com/b', 1, ['new']), true)
  assert.deepEqual(store.take(10, 'https://example.com/a', () => true), [])
  assert.deepEqual(store.take(10, 'https://example.com/b', () => true), ['new'])
  assert.deepEqual(store.take(10, 'https://example.com/b', () => true), [])
  const reload = store.begin(10, 'https://example.com/b')
  assert.equal(store.stage(10, next, 'https://example.com/b', 1, ['stale']), false)
  store.stage(10, reload, 'https://example.com/b', 1, ['expired']); now += DOCUMENT_RULE_TTL + 1
  assert.deepEqual(store.take(10, 'https://example.com/b', () => true), [])
})
test('extension disable/uninstall and guest destruction invalidate pending rules', () => {
  const store = createDocumentRuleStore()
  for (const action of ['disable', 'uninstall']) {
    const generation = store.begin(10, 'https://example.com/')
    store.stage(10, generation, 'https://example.com/', 20, [action]); store.invalidateProvider(20)
    assert.deepEqual(store.take(10, 'https://example.com/', () => true), [])
  }
  const generation = store.begin(10, 'https://example.com/'); store.invalidateGuest(10)
  assert.equal(store.stage(10, generation, 'https://example.com/', 20, ['late']), false)
})
test('navigation start retains only rules prepared for that exact document URL', () => {
  const store = createDocumentRuleStore()
  const first = store.begin(10, 'https://example.com/a')
  assert.equal(store.stage(10, first, 'https://example.com/a', 20, ['early rule']), true)
  store.navigationStarted(10, 'https://example.com/a')
  assert.deepEqual(store.take(10, 'https://example.com/a', () => true), ['early rule'])
  const second = store.begin(10, 'https://example.com/b')
  store.navigationStarted(10, 'https://example.com/a')
  assert.equal(store.stage(10, second, 'https://example.com/b', 20, ['stale rule']), false)
})
test('internal pages, extension pages, credential-bearing and OAuth URLs are excluded', () => {
  for (const url of ['vast://settings', 'chrome-extension://abc/index.html', 'devtools://devtools/', 'file:///local', 'https://user:pass@example.com/', 'https://accounts.google.com/o/oauth2/auth', 'https://example.com/oauth/callback?code=private']) assert.equal(documentRuleUrl(url), undefined, url)
  assert.equal(documentRuleUrl('https://example.com/'), 'https://example.com/')
})
test('oversized/malformed responses fail open; document capability requires persistent network authority', () => {
  for (const value of [null, [], 'script', { scripts: 'x' }, { scripts: [1] }, { scripts: ['x'.repeat(DOCUMENT_RULE_MAX_BYTES + 1)] }, { scripts: Array(129).fill('x') }]) assert.equal(sanitizeDocumentRules(value), undefined)
  const manifest = { vast_network: 1, vast_document_rules: 1, manifest_version: 2, permissions: ['webRequest', 'webRequestBlocking'], background: { persistent: true, scripts: ['background.js'] } }
  assert.equal(documentRulesManifestError(manifest), undefined)
  for (const change of [{ vast_network: 0 }, { vast_document_rules: 2 }, { manifest_version: 3 }, { permissions: [] }, { background: { persistent: false } }]) assert.ok(documentRulesManifestError({ ...manifest, ...change }))
})

test('trusted-domain resource failure leaves ordinary blocking and safe scriptlets working', async () => {
  const state = await initialize({ settings: { ...defaults(), lists: [], customFilters: '||ads.example^\nexample.com##+js(set, safeSurvived, true)' }, lists: {}, resources: { ...resources, trusted: 'invalid JSON' } })
  assert.ok(state.cache.trustedError)
  assert.equal(state.engine.match(Request.fromRawDetails({ url: 'https://ads.example/ad', sourceUrl: 'https://example.com', type: 'script' })).match, true)
  const context = page(); documentRules(state, 'https://example.com/').forEach(script => vm.runInContext(script, context))
  assert.equal(context.safeSurvived, true)
})

test('trusted-list exceptions and untrusted blanket exceptions constrain the trusted domain', async () => {
  const rule = 'example.com##+js(trusted-set-constant, approved, true)'
  assert.deepEqual(documentRules(await compile('', rule + '\nexample.com#@#+js(trusted-set-constant, approved, true)'), 'https://example.com/'), [])
  assert.deepEqual(documentRules(await compile('example.com#@#+js()', rule), 'https://example.com/'), [])
})

test('unapproved providers cannot consume pending rules and guest identities are isolated', () => {
  const store = createDocumentRuleStore(), generation = store.begin(10, 'https://example.com/')
  store.stage(10, generation, 'https://example.com/', 20, ['rule'])
  assert.deepEqual(store.take(11, 'https://example.com/', () => true), [])
  assert.deepEqual(store.take(10, 'https://example.com/', () => false), [])
})

test('adding document rules requires explicit update permission consent', async () => {
  const manifest = await validateExtensionManifest(resolve('resources/first-party-extensions/adblocker-for-vast'))
  assert.ok(manifest.permissions.includes('vast.documentRules'))
  const previous = { chrome: manifest.permissions.filter(permission => permission !== 'vast.documentRules'), hosts: [], vast: [] }
  const escalation = permissionEscalation(previous, { ...previous, chrome: manifest.permissions })
  assert.deepEqual(escalation.chrome, ['vast.documentRules'])
  assert.equal(hasPermissionEscalation(escalation), true)
})
