import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const settingsSource = source('../../src/renderer/components/settings/SettingsModal.tsx')
const controllerSource = source('../../src/renderer/components/cat-addon/CatAddonController.tsx')
const spriteSource = source('../../src/renderer/components/cat-addon/CatSprite.tsx')
const engineSource = source('../../src/renderer/components/cat-addon/cat-engine.ts')
const addressBarSource = source('../../src/renderer/components/browser/AddressBar.tsx')
const tabRowSource = source('../../src/renderer/components/tabs/TabRow.tsx')
const horizontalSource = source('../../src/renderer/components/horizontal/HorizontalChrome.tsx')
const sidebarSource = source('../../src/renderer/components/tabs/Sidebar.tsx')
const eventSource = source('../../src/renderer/lib/cat-addon-events.ts')
const styleSource = source('../../src/renderer/components/cat-addon/cat-addon.css')
const layoutSource = source('../../src/renderer/components/cat-addon/cat-layout.ts')
const defaultsSource = source('../../src/shared/constants.ts')
const preloadSource = source('../../src/preload/index.ts')
const ipcSource = source('../../src/main/ipc/cat-addon.ts')
const coreIpcSource = source('../../src/main/ipc.ts')
const windowSource = source('../../src/main/window.ts')

test('Cat Addon is disabled by default and Appearance exposes one live action', () => {
  assert.match(defaultsSource, /catAddon:\s*\{\s*enabled:\s*false\s*\}/)
  assert.match(settingsSource, /<span>Cat Addon<\/span>[\s\S]*?type="checkbox"[\s\S]*?checked=\{catAddonState\.enabled\}/)
  assert.match(settingsSource, /className="settings-grid-action md:col-span-2"[\s\S]*?<span>Visual style<\/span>[\s\S]*?<span className="settings-grid-action-value">Reset<\/span>/)
  assert.match(settingsSource, /window\.vast\.catAddon\.onStateChanged/)
  assert.doesNotMatch(settingsSource, /cat-addon-setting|cat-addon-setting-icon|settings-reset-appearance/)
  assert.doesNotMatch(settingsSource, /Cat Addon intensity|Cat Addon marketplace|Select cat animation|cat selector/i)
})

test('Cat Addon bridge exposes a validated runtime only through trusted IPC', () => {
  for (const channel of ['status', 'runtime', 'window-state', 'enable', 'disable']) {
    assert.match(ipcSource, new RegExp(`handle\\('vast:cat-addon:${channel}'`))
  }
  assert.match(coreIpcSource, /assertTrustedIpcSender\(event\)/)
  assert.match(coreIpcSource, /for \(const registerFeature of featureRegistrars\) registerFeature\(handle\)/)
  assert.match(preloadSource, /runtime:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('vast:cat-addon:runtime'\)/)
  assert.match(preloadSource, /removeListener\('vast:cat-addon:state'/)
  assert.match(windowSource, /vast:cat-addon:window-state-changed/)
  assert.match(windowSource, /if \(__VAST_CAT_ADDON_AVAILABLE__\)/)
  assert.doesNotMatch(preloadSource, /catAddon[^}]*execute|catAddon[^}]*script/s)
})

test('disabled, private, fullscreen, minimized and hidden states create no runtime layer', () => {
  assert.match(controllerSource, /!workspace\?\.isPrivate/)
  assert.match(controllerSource, /!htmlFullscreen/)
  assert.match(controllerSource, /!windowState\.fullscreen/)
  assert.match(controllerSource, /windowState\.visible && !windowState\.minimized && documentVisible/)
  assert.match(controllerSource, /reducedMotion && active && !active\.reducedMotion/)
  assert.match(controllerSource, /if \(!eligible\) return null/)
  assert.match(controllerSource, /window\.vast\.catAddon\.runtime\(\)/)
  assert.match(controllerSource, /if \(!runtime\) return null/)
  assert.doesNotMatch(controllerSource, /requestAnimationFrame|setInterval|querySelector<[^>]*>\(['"]webview/)
  assert.doesNotMatch(controllerSource, /executeJavaScript|contentDocument|webContents/)
})

test('the canonical atlas renderer is decorative, sharp and theme-independent', () => {
  assert.match(controllerSource, /aria-hidden="true"/)
  assert.match(controllerSource, /role="presentation"/)
  assert.match(spriteSource, /data-source-character="Cat_Grey_White"/)
  assert.match(spriteSource, /backgroundImage:\s*`url/)
  assert.match(spriteSource, /catScaleForDpi/)
  assert.match(spriteSource, /snapCatCoordinate/)
  assert.match(spriteSource, /'--cat-frame-size': style\['--cat-frame-size'\]/)
  assert.match(styleSource, /\.cat-addon-layer,\s*\.cat-addon-layer \*\s*\{[\s\S]*?pointer-events:\s*none !important;/)
  assert.match(styleSource, /image-rendering:\s*pixelated/)
  assert.match(styleSource, /image-rendering:\s*crisp-edges/)
  assert.match(styleSource, /background-position:\s*var\(--cat-atlas-x\) var\(--cat-atlas-y\)/)
  assert.match(styleSource, /\.cat-scene-surface--clipped\s*\{[\s\S]*?clip-path:\s*inset/)
  assert.match(styleSource, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(`${controllerSource}\n${spriteSource}\n${styleSource}`, /<svg|<path|<rect|--cat-ink|light-theme.*cat/i)
})

test('the old procedural white cat and its obsolete assets are unreachable', () => {
  assert.equal(existsSync(new URL('../../src/renderer/components/cat-addon/TailoredPixelCat.tsx', import.meta.url)), false)
  assert.doesNotMatch(`${controllerSource}\n${spriteSource}\n${engineSource}`, /TailoredPixelCat|cat-part--|cat_motion|cat_still|cat_source\.gif/)
  assert.match(controllerSource, /data-testid="cat-addon-resident"/)
  assert.match(controllerSource, /data-cat-count=\{1 \+ \(scene\.snapshot\.visible \? 1 : 0\)\}/)
})

test('atlas, animator, actor and scene director separate sprite timing from movement', () => {
  for (const className of ['CatSpriteAtlas', 'CatAnimator', 'CatActor', 'CatSceneDirector']) {
    assert.match(engineSource, new RegExp(`export class ${className}`))
  }
  assert.match(engineSource, /frame\.duration_ms/)
  assert.match(engineSource, /animation\.loop === 'ping-pong'/)
  assert.match(engineSource, /options\.reverse/)
  assert.match(engineSource, /setVisible\(visible: boolean\)/)
  assert.match(engineSource, /cancel\(\): boolean/)
  assert.match(styleSource, /transform:\s*translate3d/)
  assert.match(styleSource, /transition:[\s\S]*?transform var\(--cat-transition-ms\) linear/)
})

test('required browser scenes use inspected source animation IDs', () => {
  const scenes = [
    'omnibox-peek', 'paw-swat', 'tab-run', 'tab-tail', 'tab-climb', 'closing-tab-paw',
    'new-tab-reaction', 'toolbar-patrol', 'edge-zoomies', 'tab-nap', 'sidebar-sneak', 'bookmark-paw',
    'idle-cat', 'secret-meow', 'secret-pspsps', 'secret-smile', 'secret-vast-cat'
  ]
  for (const scene of scenes) assert.match(controllerSource, new RegExp(`case '${scene}'|id === '${scene}'`))
  for (const animation of ['spawn_1', 'sit_lift', 'attack_1', 'run_1', 'climb_1', 'climb_2', 'climb_3', 'climb_jump_1', 'scratch_1', 'dream', 'dance']) {
    assert.match(controllerSource, new RegExp(`animation: '${animation}'`))
  }
  assert.match(controllerSource, /activeTab\?\.status === 'error'/)
  assert.match(controllerSource, /activeTab\?\.lifecycle === 'crashed'/)
  assert.match(controllerSource, /resident\.actor\.play\('sit_no'/)
  assert.match(controllerSource, /case 'secret-pspsps'[\s\S]*?type: 'hide'[\s\S]*?facing: 'left'/)
  assert.match(controllerSource, /case 'secret-vast-cat'[\s\S]*?climb_3[\s\S]*?run_2[\s\S]*?attack_1[\s\S]*?dance[\s\S]*?jump_air/)
})

test('scene geometry keeps chrome and tab animations visibly inside the viewport', () => {
  assert.match(layoutSource, /export function clampCatY/)
  assert.match(layoutSource, /anchor\.top \+ anchor\.height - overlap/)
  assert.match(layoutSource, /isHorizontalCatRail/)
  assert.match(controllerSource, /catChromeY\(anchor, viewportHeight\)/)
  assert.match(controllerSource, /catRailY\(anchor, viewportHeight\)/)
  assert.match(controllerSource, /desiredScale=\{CAT_SCENE_SCALE\}/)
  assert.match(controllerSource, /data-scene-start-count=\{sceneStartCount\}/)
  assert.doesNotMatch(controllerSource, /anchor\.top - 5[0248]|bottom - 58|Math\.max\(-6, anchor\.top/)
})

test('omnibox and tab hooks emit passive local events without changing native actions', () => {
  assert.match(addressBarSource, /isComposing/)
  assert.match(addressBarSource, /onCompositionEnd/)
  assert.match(addressBarSource, /notifyCatOmniboxInput\(event\.target\.value\)/)
  assert.match(eventSource, /window\.dispatchEvent\(new CustomEvent/)
  assert.match(addressBarSource, /notifyCatOmniboxFocus\(\)/)
  assert.match(controllerSource, /CAT_ADDON_EVENT\.omniboxFocus/)
  assert.doesNotMatch(controllerSource, /omniboxBlur[\s\S]{0,220}scheduler\.cancel/)
  assert.doesNotMatch(eventSource, /preventDefault|stopPropagation|localStorage|fetch\(/)
  assert.match(tabRowSource, /notifyCatTabClosing\(\)/)
  assert.match(horizontalSource, /notifyCatNewTabButton\(\)/)
  assert.match(sidebarSource, /notifyCatNewTabButton\(\)/)
  for (const phrase of ['meow', 'pspsps', ':3', 'vast cat']) assert.match(controllerSource, new RegExp(`case '${phrase.replace(':', '\\:')}'`))
})

test('cat presence uses frequent tiered activity without a permanent render loop', () => {
  assert.match(controllerSource, /startupQuietMs:\s*3_000/)
  assert.match(controllerSource, /globalCooldownMs:\s*9_000/)
  assert.match(controllerSource, /interactionCooldownMs:\s*2_800/)
  assert.match(controllerSource, /armAmbient\(11_000 \+ ambientIndex % 4 \* 1_500\)/)
  assert.match(controllerSource, /scheduler\.request\(id, \{ probability: 1/)
  assert.match(controllerSource, /document\.querySelector\('\.settings-modal-shell'\)[\s\S]*?armAmbient\(1_200\)/)
  assert.match(controllerSource, /request\('new-tab-reaction', \{ interaction: true, probability: 1/)
  assert.match(controllerSource, /request\('closing-tab-paw', \{ interaction: true, probability: 0\.96/)
  assert.match(controllerSource, /!activeRef\.current/)
  assert.match(controllerSource, /residentDirector\.run\(routine\(index\+\+\)/)
  assert.match(controllerSource, /scratch_2/)
  assert.match(controllerSource, /homeX - 120/)
  assert.doesNotMatch(controllerSource, /requestAnimationFrame|setInterval/)
})
