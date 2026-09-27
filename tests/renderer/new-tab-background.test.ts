import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const typesSource = source('src/shared/types.ts')
const defaultsSource = source('src/shared/constants.ts')
const storageSource = source('src/main/storage.ts')
const appSource = source('src/renderer/app/App.tsx')
const settingsSource = source('src/renderer/components/settings/SettingsModal.tsx')
const newTabSource = source('src/renderer/components/new-tab/NewTabPage.tsx')
const stylesSource = source('src/renderer/styles/index.css')
const backgroundSource = source('src/main/new-tab-background.ts')
const backgroundIpcSource = source('src/main/ipc/new-tab-background.ts')
const preloadSource = source('src/preload/index.ts')

const backgrounds = ['space-black', 'accent-gradient', 'carbon-black', 'depth', 'adaptive', 'custom'] as const

test('New Tab owns one six-option background setting independently of global appearance', () => {
  for (const background of backgrounds) {
    assert.match(typesSource, new RegExp(`'${background}'`))
    assert.match(settingsSource, new RegExp(`value: '${background}'`))
  }
  assert.match(defaultsSource, /newTab:\s*{\s*background: 'space-black'/s)
  assert.doesNotMatch(typesSource, /backgroundStyle/)
  assert.doesNotMatch(defaultsSource, /backgroundStyle/)
  assert.doesNotMatch(appSource, /data-appearance-bg|backgroundStyle/)
  assert.match(storageSource, /\['newTab\.background', new Set\(\['space-black', 'accent-gradient', 'carbon-black', 'depth', 'adaptive', 'custom'\]\)\]/)
})

test('legacy global presets migrate once into the dedicated New Tab setting', () => {
  assert.match(storageSource, /legacyAppearance\.backgroundStyle/)
  assert.match(storageSource, /carbon: 'space-black'/)
  assert.match(storageSource, /frost: 'adaptive'/)
})

test('New Tab backgrounds stay dark, restrained, and scoped to the page', () => {
  assert.match(newTabSource, /data-new-tab-background/)
  assert.match(stylesSource, /\.new-tab-page\[data-new-tab-background='accent-gradient'\][\s\S]*?var\(--vast-accent\) 10%/)
  assert.match(stylesSource, /\.new-tab-page\[data-new-tab-background='carbon-black'\][\s\S]*?background-color: #141414/)
  assert.match(stylesSource, /\.new-tab-page\[data-new-tab-background='depth'\][\s\S]*?linear-gradient/)
  assert.match(stylesSource, /\.light-theme \.new-tab-page\[data-new-tab-background='adaptive'\]/)
  assert.match(stylesSource, /\.new-tab-page\[data-new-tab-background='custom'\][\s\S]*?var\(--vast-new-tab-image, none\)/)
  assert.doesNotMatch(stylesSource, /\.app-shell\[data-appearance-bg=/)
  assert.doesNotMatch(stylesSource, /\.browser-stage\.is-new-tab \.new-tab-page\s*{[\s\S]*?background-image:\s*none/)
})

test('Custom uses a native PNG/JPEG picker and persists a validated local copy', () => {
  assert.match(backgroundSource, /extensions: \['png', 'jpg', 'jpeg'\]/)
  assert.match(backgroundSource, /MAX_BACKGROUND_BYTES = 20 \* 1024 \* 1024/)
  assert.match(backgroundSource, /0x89[\s\S]*0x50[\s\S]*0x4e[\s\S]*0x47/)
  assert.match(backgroundSource, /0xff[\s\S]*0xd8[\s\S]*0xff/)
  assert.match(backgroundSource, /nativeImage\.createFromBuffer/)
  assert.match(backgroundSource, /dataFilePath\(BACKGROUND_FILE_NAME\)/)
  assert.match(backgroundSource, /await writeFile\(path, bytes\)/)
  assert.doesNotMatch(backgroundSource, /filePath:/)
  assert.match(backgroundIpcSource, /vast:new-tab-background:get/)
  assert.match(backgroundIpcSource, /vast:new-tab-background:choose/)
  assert.match(preloadSource, /newTabBackground:\s*{[\s\S]*vast:new-tab-background:get[\s\S]*vast:new-tab-background:choose/)
})
