import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const rendererCss = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const openingCss =
  rendererCss.match(/\.vast-opening-overlay\s*\{(?<body>[\s\S]*?)@keyframes vast-preload-logo/)?.groups?.body ?? ''
const logoRule = rendererCss.match(/\.vast-opening-logo\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? ''
const haloRule = rendererCss.match(/\.vast-opening-logo-halo\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? ''
const overlayRule = rendererCss.match(/\.vast-opening-overlay\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? ''

test('main-renderer opening logo crops transparent asset padding and centers its visible mark', () => {
  assert.match(logoRule, /position:\s*absolute;/)
  assert.match(logoRule, /left:\s*calc\(50%\s*-\s*2\.07%\);/)
  assert.match(logoRule, /top:\s*calc\(50%\s*-\s*5\.4%\);/)
  assert.match(logoRule, /width:\s*321\.3%;/)
  assert.match(logoRule, /max-width:\s*none;/)
  assert.match(logoRule, /height:\s*auto;/)
  assert.match(logoRule, /aspect-ratio:\s*4\s*\/\s*1;/)
  assert.match(logoRule, /object-fit:\s*contain;/)
  assert.match(logoRule, /transform:\s*translate\(-50%,\s*-50%\);/)
})

test('opening animation avoids large blur filters that lower launch FPS', () => {
  assert.doesNotMatch(openingCss, /filter:\s*blur\(/)
})

test('main-renderer opening overlay paints its opaque background immediately', () => {
  assert.match(overlayRule, /linear-gradient\(180deg,\s*#030406/)
  assert.match(overlayRule, /width:\s*100vw;/)
  assert.match(overlayRule, /height:\s*100vh;/)
  assert.match(overlayRule, /border-radius:\s*0;/)
  assert.doesNotMatch(overlayRule, /animation:\s*vast-opening-overlay/)
})

test('opening logo glow is high resolution dark purple instead of white', () => {
  assert.match(haloRule, /width:\s*min\(64vw,\s*56rem\);/)
  assert.match(haloRule, /rgba\(91,\s*64,\s*168,/)
  assert.match(haloRule, /rgba\(38,\s*24,\s*74,/)
  assert.doesNotMatch(haloRule, /rgba\(255,\s*255,\s*255,/)
})
