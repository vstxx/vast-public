import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const rendererCss = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const openingCss =
  rendererCss.match(/\.vast-opening-overlay\s*\{(?<body>[\s\S]*?)@keyframes vast-preload-logo/)?.groups?.body ?? ''
const logoRule = rendererCss.match(/\.vast-opening-logo\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? ''
const haloRule = rendererCss.match(/\.vast-opening-logo-halo\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? ''
const overlayRule = rendererCss.match(/\.vast-opening-overlay\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? ''

test('main-renderer opening logo preserves the native 4:1 logo ratio', () => {
  assert.match(logoRule, /width:\s*min\(110vw,\s*48rem\);/)
  assert.match(logoRule, /max-width:\s*none;/)
  assert.match(logoRule, /height:\s*auto;/)
  assert.match(logoRule, /aspect-ratio:\s*4\s*\/\s*1;/)
  assert.match(logoRule, /object-fit:\s*contain;/)
  assert.doesNotMatch(logoRule, /height:\s*7rem;/)
  assert.doesNotMatch(logoRule, /max-width:\s*min\(78vw,\s*24rem\);/)
})

test('opening animation avoids large blur filters that lower launch FPS', () => {
  assert.doesNotMatch(openingCss, /filter:\s*blur\(/)
})

test('main-renderer opening overlay paints its opaque background immediately', () => {
  assert.match(overlayRule, /linear-gradient\(180deg,\s*#030406/)
  assert.doesNotMatch(overlayRule, /animation:\s*vast-opening-overlay/)
})

test('opening logo glow is high resolution dark purple instead of white', () => {
  assert.match(haloRule, /width:\s*min\(64vw,\s*56rem\);/)
  assert.match(haloRule, /rgba\(91,\s*64,\s*168,/)
  assert.match(haloRule, /rgba\(38,\s*24,\s*74,/)
  assert.doesNotMatch(haloRule, /rgba\(255,\s*255,\s*255,/)
})
