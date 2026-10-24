import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createActiveSectionStore } from '../../src/renderer/components/settings/active-section-store.ts'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

test('the Settings nav highlight store notifies only on real changes', () => {
  const store = createActiveSectionStore<'A' | 'B'>('A')
  let notified = 0
  const unsubscribe = store.subscribe(() => { notified++ })
  store.set('A')
  assert.equal(notified, 0)
  store.set('B')
  assert.equal(store.get(), 'B')
  assert.equal(notified, 1)
  unsubscribe()
  store.set('A')
  assert.equal(notified, 1)
})

// Scrolling across a section boundary used to re-render the whole modal.
test('the Settings scroll spy updates only the nav, not modal state', () => {
  const settings = read('components/settings/SettingsModal.tsx')
  assert.doesNotMatch(settings, /useState<SettingsSectionId>/)
  assert.match(settings, /const setActiveSection = activeSectionStore\.set/)
  assert.match(settings, /const activeSection = useSyncExternalStore\(store\.subscribe, store\.get\)/)
  assert.match(settings, /<SettingsNavItems items=\{visibleSettingsNav\} store=\{activeSectionStore\} onSelect=\{selectNavSection\} \/>/)
  const nav = settings.slice(settings.indexOf('const SettingsNavItems = memo('), settings.indexOf('export function SettingsModal('))
  assert.doesNotMatch(nav, /transition[^:]/, 'the highlight switches without a per-frame transition')
})

test('no root class or CSS variable flips while the user scrolls', () => {
  assert.doesNotMatch(read('app/App.tsx'), /is-scrolling/)
  assert.doesNotMatch(read('styles/index.css'), /is-scrolling/)
})

// A non-passive wheel listener makes the compositor wait for the main thread
// before every scroll in the shell.
test('the Ctrl+wheel zoom listener is non-passive only while a zoom modifier is held', () => {
  const app = read('app/App.tsx')
  const listeners = [...app.matchAll(/addEventListener\('wheel', [^)]*\)/g)].map((match) => match[0])
  assert.equal(listeners.length, 1)
  const attach = app.slice(app.indexOf('const attach = (): void => {'), app.indexOf('const detach = (): void => {'))
  assert.match(attach, /window\.addEventListener\('wheel', onWheel, \{ capture: true, passive: false \}\)/)
  assert.match(app, /if \(event\.key === 'Control' \|\| event\.key === 'Meta' \|\| event\.ctrlKey \|\| event\.metaKey\) attach\(\)/)
  assert.match(app, /window\.addEventListener\('blur', detach\)/)
})

test('palette rows follow real pointer movement, not rows scrolling under the pointer', () => {
  const palette = read('components/command-palette/CommandPalette.tsx')
  assert.doesNotMatch(palette, /onMouseEnter=\{\(\) => setSelected/)
  assert.match(palette, /if \(\(event\.movementX !== 0 \|\| event\.movementY !== 0\) && index !== selected\) setSelected\(index\)/)
})
