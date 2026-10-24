import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'
import {
  DEFAULT_VISUAL_PROFILE_VALUES,
  VISUAL_PROFILE_FIELDS,
  VISUAL_PROFILE_MAX_FILE_BYTES,
  VISUAL_PROFILE_MAX_IMAGE_BYTES,
  effectiveVisualProfileValues,
  normalizeVisualProfileName,
  parseVisualProfileDocument,
  parseVisualProfileValues,
  sameVisualProfileValues,
  serializeVisualProfileDocument,
  uniqueVisualProfileName,
  visualProfileSettingsPatch,
  visualProfileValuesFromSettings,
  type VisualProfileValues
} from '../../src/shared/visual-profile.ts'
import type { BrowserSettings } from '../../src/shared/types.ts'

// Bundle the real store so profiles are applied through its actual reducer.
const require = createRequire(import.meta.url)
const Module = require('node:module')
const entry = fileURLToPath(new URL('../../src/renderer/store/browser-store.ts', import.meta.url))
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' }).outputFiles[0].text
const compiled = new Module(entry)
compiled.filename = entry
compiled.paths = Module._nodeModulePaths(dirname(entry))
compiled._compile(code, entry)
const store = compiled.exports.useBrowserStore

const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')

// A look that differs from the defaults in every field.
const sample: VisualProfileValues = {
  theme: 'dim',
  layoutMode: 'vertical',
  accentColor: '#3d7bff',
  secondaryAccentColor: '#0f5132',
  backgroundTintColor: '#101418',
  surfaceTintColor: '#202830',
  forceDarkModeWebsites: true,
  animations: false,
  openingAnimation: true,
  openingAnimationSoundVolume: 35,
  bookmarksBarVisible: false,
  bookmarksBarOnlyOnNewTab: true,
  cleanToolbarIcons: false,
  sidebarDensity: 'compact',
  sidePanelMode: 'overlay',
  sidePanelWidth: 480,
  sidePanelShowLabels: false,
  newTabBackground: 'depth',
  cornerRadius: 12,
  blurIntensity: 40,
  transparency: 60,
  glassIntensity: 20,
  glowIntensity: 30,
  borderIntensity: 70,
  shadowIntensity: 55,
  gradientIntensity: 10,
  panelOpacity: 90,
  saturation: 120
}

function paths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key))
}

function resetStore(): void {
  store.setState(store.getInitialState(), true)
}

test('the allowlist is exactly the settings the Appearance page edits', () => {
  const section = settingsSource.slice(settingsSource.indexOf('<section id="Appearance"'), settingsSource.indexOf('<section id="Advanced"'))
  const edited = new Set<string>()
  for (const match of section.matchAll(/updateSettings\(\{\s*(\w+)(?::\s*\{\s*(\w+))?/g)) edited.add(match[2] ? `${match[1]}.${match[2]}` : match[1])
  const covered = new Set(paths(visualProfileSettingsPatch(sample)))
  assert.deepEqual([...covered].sort(), [...edited].sort())
  assert.equal(Object.keys(VISUAL_PROFILE_FIELDS).length, covered.size)
  // The hidden chromeOpacity and the legacy tabLayout stay out on purpose.
  assert.ok(!covered.has('appearance.chromeOpacity') && !covered.has('tabLayout'))
})

test('a profile round-trips through the real store in one update', () => {
  resetStore()
  const before = store.getState().settings
  store.getState().updateSettings(visualProfileSettingsPatch(sample))
  const after: BrowserSettings = store.getState().settings
  assert.deepEqual(visualProfileValuesFromSettings(after), sample)
  assert.equal(after.appearance.chromeOpacity, before.appearance.chromeOpacity)
})

test('applying a profile leaves every setting outside Appearance untouched', () => {
  resetStore()
  store.getState().updateSettings({
    privacy: { ...DEFAULT_SETTINGS.privacy, blockThirdPartyCookies: true, disableHistory: true },
    labs: { ...DEFAULT_SETTINGS.labs },
    advanced: { ...DEFAULT_SETTINGS.advanced, experimentalFeatures: false },
    defaultSearchEngine: 'duckduckgo',
    newTab: { showNotes: true }
  })
  const before: BrowserSettings = structuredClone(store.getState().settings)
  store.getState().updateSettings(visualProfileSettingsPatch(sample))
  const after: BrowserSettings = store.getState().settings
  const touched = new Set(paths(visualProfileSettingsPatch(sample)))
  for (const path of paths(before)) {
    if (touched.has(path)) continue
    const read = (settings: unknown): unknown => path.split('.').reduce((node: any, key) => node?.[key], settings)
    assert.deepEqual(read(after), read(before), path)
  }
})

test('Purist from a profile does not switch on experimental features', () => {
  resetStore()
  store.getState().updateSettings(visualProfileSettingsPatch({ ...sample, layoutMode: 'purist' }))
  const settings: BrowserSettings = store.getState().settings
  assert.equal(settings.advanced.experimentalFeatures, false)
  assert.equal(settings.layoutMode, 'horizontal')
  assert.ok(sameVisualProfileValues(effectiveVisualProfileValues({ ...sample, layoutMode: 'purist' }, false), visualProfileValuesFromSettings(settings)))
})

test('snapshots bring out-of-range or malformed current values back inside the schema', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.accentColor = 'rgb(1,2,3)'
  settings.appearance.cornerRadius = 99.6
  settings.appearance.saturation = 12
  settings.sidePanel.width = 400.4
  settings.appearance.surfaceTintColor = '#ABCDEF'
  const values = visualProfileValuesFromSettings(settings)
  assert.equal(values.accentColor, DEFAULT_SETTINGS.accentColor)
  assert.equal(values.cornerRadius, 36)
  assert.equal(values.saturation, 80)
  assert.equal(values.sidePanelWidth, 400)
  assert.equal(values.surfaceTintColor, '#abcdef')
  assert.deepEqual(parseVisualProfileValues(values), values)
  assert.deepEqual(parseVisualProfileValues(DEFAULT_VISUAL_PROFILE_VALUES), DEFAULT_VISUAL_PROFILE_VALUES)
})

test('values are rejected unless they match the schema exactly', () => {
  const bad: Array<[string, unknown]> = [
    ['extra key', { ...sample, blockTrackers: false }],
    ['missing key', (({ saturation: _saturation, ...rest }) => rest)(sample)],
    ['number as string', { ...sample, cornerRadius: '12' }],
    ['fractional number', { ...sample, transparency: 12.5 }],
    ['below range', { ...sample, cornerRadius: 5 }],
    ['above range', { ...sample, sidePanelWidth: 521 }],
    ['NaN', { ...sample, glowIntensity: Number.NaN }],
    ['short color', { ...sample, accentColor: '#fff' }],
    ['named color', { ...sample, accentColor: 'red' }],
    ['css injection', { ...sample, accentColor: '#000000;background:url(x)' }],
    ['unknown enum', { ...sample, theme: 'neon' }],
    ['nested object', { ...sample, theme: { value: 'dark' } }],
    ['array', [sample]],
    ['null', null],
    ['class instance', new Date()]
  ]
  for (const [label, value] of bad) assert.throws(() => parseVisualProfileValues(value), Error, label)
})

const documentText = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ format: 'vast.visual-profile', version: 1, name: 'Ocean', appearance: sample, ...overrides })

test('documents round-trip and carry only the allowlisted values', () => {
  const text = serializeVisualProfileDocument({ name: 'Ocean', values: sample })
  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed).sort(), ['appearance', 'format', 'name', 'version'])
  assert.ok(text.length < 2_000, 'a profile without an image stays tiny')
  assert.deepEqual(parseVisualProfileDocument(text), { name: 'Ocean', values: sample })
  const custom = { ...sample, newTabBackground: 'custom' as const }
  const withImage = parseVisualProfileDocument(serializeVisualProfileDocument({ name: 'Ocean', values: custom, image: { type: 'image/png', data: 'iVBORw0KGgo=' } }))
  assert.deepEqual(withImage.image, { type: 'image/png', data: 'iVBORw0KGgo=' })
})

test('malicious and malformed documents are rejected before anything is applied', () => {
  const rejected: Array<[string, string]> = [
    ['not JSON', '{"format":'],
    ['not an object', '[]'],
    ['wrong format', documentText({ format: 'vast.theme' })],
    ['newer version', documentText({ version: 2 })],
    ['older version', documentText({ version: 0 })],
    ['string version', documentText({ version: '1' })],
    ['settings outside Appearance', documentText({ settings: { privacy: { blockTrackers: false } } })],
    ['labs smuggled into appearance', documentText({ appearance: { ...sample, labs: { automation: true } } })],
    ['prototype pollution at top level', documentText().replace('{', '{"__proto__":{"polluted":true},')],
    ['prototype pollution in values', documentText().replace('"appearance":{', '"appearance":{"__proto__":{"polluted":true},')],
    ['constructor key', documentText({ appearance: { ...sample, constructor: { prototype: {} } } })],
    ['empty name', documentText({ name: '   ' })],
    ['name too long', documentText({ name: 'x'.repeat(49) })],
    ['image without Custom background', documentText({ image: { type: 'image/png', data: 'iVBORw0KGgo=' } })],
    ['svg image', documentText({ appearance: { ...sample, newTabBackground: 'custom' }, image: { type: 'image/svg+xml', data: 'PHN2Zz4=' } })],
    ['remote image', documentText({ appearance: { ...sample, newTabBackground: 'custom' }, image: { type: 'image/png', data: 'https://example.com/a.png' } })],
    ['image extra key', documentText({ appearance: { ...sample, newTabBackground: 'custom' }, image: { type: 'image/png', data: 'iVBORw0KGgo=', path: 'C:/Users/me/a.png' } })],
    ['oversized image', documentText({ appearance: { ...sample, newTabBackground: 'custom' }, image: { type: 'image/png', data: 'A'.repeat(Math.ceil(VISUAL_PROFILE_MAX_IMAGE_BYTES / 3) * 4 + 4) } })]
  ]
  for (const [label, text] of rejected) assert.throws(() => parseVisualProfileDocument(text), Error, label)
  assert.throws(() => parseVisualProfileDocument(' '.repeat(VISUAL_PROFILE_MAX_FILE_BYTES + 1)), /too large/)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.match(String((() => { try { parseVisualProfileDocument(documentText({ version: 2 })) } catch (error) { return error } })()), /newer version of Vast/)
})

test('names are cleaned of control and direction-override characters and kept unique', () => {
  assert.equal(normalizeVisualProfileName('  Night\u202E  owl\u0007 '), 'Night owl')
  assert.throws(() => normalizeVisualProfileName('\u200B\u200F'))
  assert.equal(uniqueVisualProfileName('Ocean', ['ocean', 'Ocean 2']), 'Ocean 3')
  assert.equal(uniqueVisualProfileName('Dusk', ['Ocean']), 'Dusk')
  assert.ok([...uniqueVisualProfileName('x'.repeat(48), ['x'.repeat(48)])].length <= 48)
})
