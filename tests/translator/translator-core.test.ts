import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { catalogLanguages, MODEL_BUCKET, modelUrl, pairDownloadBytes, parseCatalog, planRoute } from '../../resources/first-party-extensions/translator-for-vast/src/shared/catalog.ts'
import { LIMITS, parseContentRequest, parsePageCommand, parsePageState, parseUiRequest, SCOPE } from '../../resources/first-party-extensions/translator-for-vast/src/shared/protocol.ts'
import { normalizeHost, sanitizeSettings, siteBlocked } from '../../resources/first-party-extensions/translator-for-vast/src/shared/settings.ts'
import { prepareForEngine, restoreEdges } from '../../resources/first-party-extensions/translator-for-vast/src/shared/text.ts'
import { normalizeLanguageTag, isRtlLanguage } from '../../resources/first-party-extensions/translator-for-vast/src/shared/languages.ts'

const root = new URL('../../resources/first-party-extensions/translator-for-vast/', import.meta.url)
const packaged = JSON.parse(readFileSync(new URL('catalog/models.json', root), 'utf8'))

test('the packaged catalog parses and covers EN↔PL directly', () => {
  const catalog = parseCatalog(packaged)
  const toPolish = planRoute(catalog, 'en', 'pl')
  const fromPolish = planRoute(catalog, 'pl', 'en')
  assert.equal(toPolish?.length, 1)
  assert.equal(fromPolish?.length, 1)
  assert.ok(toPolish![0]!.files.model && toPolish![0]!.files.vocab)
  assert.ok(pairDownloadBytes(toPolish![0]!) > 10_000_000)
  for (const pair of Object.values(catalog.pairs)) for (const file of Object.values(pair.files)) assert.ok(modelUrl(file!).startsWith(MODEL_BUCKET))
})

test('routes pivot through English only when both hops exist, and never offer the impossible', () => {
  const catalog = parseCatalog(packaged)
  const pivot = planRoute(catalog, 'pl', 'de')
  assert.deepEqual(pivot?.map((pair) => `${pair.source}-${pair.target}`), ['pl-en', 'en-de'])
  assert.equal(planRoute(catalog, 'pl', 'pl'), null)
  assert.equal(planRoute(catalog, 'pl', 'xx'), null)
  const { sources, targets } = catalogLanguages(catalog)
  assert.ok(sources.includes('pl') && targets.includes('pl') && targets.includes('en'))
  for (const target of targets) if (target !== 'en') assert.ok(planRoute(catalog, 'en', target), `en->${target}`)
})

test('catalog parsing rejects anything that could redirect or enlarge a download', () => {
  const base = structuredClone(packaged)
  const pair = base.pairs['en-pl']
  const bad = (mutate: (value: typeof base) => void) => {
    const copy = structuredClone(base)
    mutate(copy)
    assert.throws(() => parseCatalog(copy))
  }
  bad((value) => { value.pairs['en-pl'].files.model.path = '../../evil/model.gz' })
  bad((value) => { value.pairs['en-pl'].files.model.path = 'https://evil.example/model.gz' })
  bad((value) => { value.pairs['en-pl'].files.model.sha256 = 'abc' })
  bad((value) => { value.pairs['en-pl'].files.model.bytes = 10 ** 12 })
  bad((value) => { value.pairs['en-pl'].files.script = pair.files.model })
  bad((value) => { delete value.pairs['en-pl'].files.vocab })
  bad((value) => { value.pairs['en-pl'].source = 'de' })
  bad((value) => { value.modelMajor = 4 })
  bad((value) => { value.pairs['de-fr'] = { ...pair, source: 'de', target: 'fr' } })
})

test('content-script messages are validated for shape and size', () => {
  const fragment = 'x'.repeat(LIMITS.fragmentChars)
  assert.ok(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'pl', fragments: ['Hello'], priority: 'page' }))
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'en', fragments: ['Hello'], priority: 'page' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'pl', fragments: [], priority: 'page' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'pl', fragments: [fragment + 'x'], priority: 'page' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'pl', fragments: new Array(5).fill(fragment), priority: 'page' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'pl', fragments: [1], priority: 'page' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:translate', source: 'en', target: 'pl', fragments: ['a'], priority: 'urgent' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'engine:delete-all-models' }), null)
  assert.equal(parseContentRequest({ scope: 'other', type: 'content:cancel' }), null)
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:detect', sample: 'x'.repeat(LIMITS.sampleChars + 1), declared: null }), null)
  assert.ok(parseContentRequest({ scope: SCOPE, type: 'content:download', source: 'pl', target: 'en' }))
  assert.equal(parseContentRequest({ scope: SCOPE, type: 'content:download', source: '../x', target: 'en' }), null)
})

test('extension-page and page-command messages are validated', () => {
  assert.ok(parseUiRequest({ scope: SCOPE, type: 'ui:translate', tabId: 3, source: 'en', target: 'pl' }))
  assert.equal(parseUiRequest({ scope: SCOPE, type: 'ui:translate', tabId: -1, source: 'en', target: 'pl' }), null)
  assert.equal(parseUiRequest({ scope: SCOPE, type: 'ui:delete-model', pairKey: '../../x' }), null)
  assert.ok(parseUiRequest({ scope: SCOPE, type: 'ui:delete-model', pairKey: 'en-pl' }))
  assert.ok(parsePageCommand({ scope: SCOPE, type: 'page:translate', source: 'en', target: 'pl', displayMode: 'bilingual' }))
  assert.equal(parsePageCommand({ scope: SCOPE, type: 'page:translate', source: 'en', target: 'pl', displayMode: 'html' }), null)
  assert.equal(parsePageState({ status: 'translated', source: 'en', target: 'pl', done: -1, total: 0, error: null, kept: 0 }), null)
})

test('settings are sanitized from whatever storage holds', () => {
  const settings = sanitizeSettings({ targetLanguage: '<script>', displayMode: 'x', selectionButton: 'yes', alwaysTranslate: ['de', 'de', 'xx-YY-ZZ', 5], neverTranslateSites: ['https://www.Example.com/path', 'bad host', 'mail.example.org.'], idleSeconds: 999999 })
  assert.equal(settings.targetLanguage, null)
  assert.equal(settings.displayMode, 'replace')
  assert.equal(settings.selectionButton, false)
  assert.deepEqual(settings.alwaysTranslate, ['de'])
  assert.deepEqual(settings.neverTranslateSites, ['example.com', 'mail.example.org'])
  assert.equal(settings.idleSeconds, 600)
  assert.ok(siteBlocked(settings, 'news.example.com'))
  assert.ok(!siteBlocked(settings, 'example.com.evil.net'))
  assert.equal(normalizeHost('localhost'), 'localhost')
  assert.equal(normalizeHost('javascript:alert(1)'), null)
})

test('text preparation keeps page edges and strips what confuses the model', () => {
  const prepared = prepareForEngine('  co­operate \n', 'en')
  assert.equal(prepared.core, 'cooperate')
  assert.equal(restoreEdges(' współpracować ', prepared), '  współpracować \n')
  assert.equal(restoreEdges('   ', prepared), '')
  assert.equal(prepareForEngine('今日は晴れ。「明日は？」', 'ja').core, '今日は晴れ。 「明日は？」')
})

test('language tags normalise to catalog spelling', () => {
  assert.equal(normalizeLanguageTag('pl-PL'), 'pl')
  assert.equal(normalizeLanguageTag('zh-TW'), 'zh-Hant')
  assert.equal(normalizeLanguageTag('zh'), 'zh-Hans')
  assert.equal(normalizeLanguageTag('no'), 'nb')
  assert.equal(normalizeLanguageTag('iw'), 'he')
  assert.equal(normalizeLanguageTag('x'.repeat(40)), null)
  assert.ok(isRtlLanguage('ar-EG') && isRtlLanguage('he') && !isRtlLanguage('pl'))
})

test('the manifest keeps the network, code and permission boundaries', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'))
  const policy: string = manifest.content_security_policy.extension_pages
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval';/)
  assert.match(policy, /connect-src 'self' https:\/\/storage\.googleapis\.com\/moz-fx-translations-data--303e-prod-translations-data\/$/)
  assert.doesNotMatch(policy, /(?<!wasm-)'unsafe-eval'|unsafe-inline/)
  assert.deepEqual(manifest.vast_wasm, { modules: ['bergamot-translator.wasm'] })
  assert.equal(manifest.content_scripts, undefined, 'No content script may be declared for every site.')
  assert.deepEqual(manifest.permissions.sort(), ['contextMenus', 'offscreen', 'scripting', 'storage', 'unlimitedStorage'])
  assert.deepEqual(manifest.vast.permissions, ['vast.toolbar'])
  assert.equal(manifest.vast.background, undefined, 'A Native background host must not be needed for the toolbar.')
})
