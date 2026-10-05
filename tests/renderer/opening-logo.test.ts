import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const splashSource = readFileSync(new URL('../../src/main/opening-splash.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const documentSource = splashSource.match(/function splashDocument\([\s\S]*?return `data:text\/html[\s\S]*`/)?.[0] ?? ''
const logoRule = documentSource.match(/\.vast-opening-logo \{(?<body>[\s\S]*?)\n  \}/)?.groups?.body ?? ''
const haloRule = documentSource.match(/\.vast-opening-logo-halo \{(?<body>[\s\S]*?)\n  \}/)?.groups?.body ?? ''
const overlayRule = documentSource.match(/\.vast-opening-overlay \{(?<body>[\s\S]*?)\n  \}/)?.groups?.body ?? ''

test('packaged splash loads the same wordmark artwork used in development', () => {
  assert.match(splashSource, /join\(process\.cwd\(\), 'assets', 'logos', 'vast\.png'\)/)
  assert.match(splashSource, /join\(process\.resourcesPath, 'app-wordmark\.png'\)/)
  assert.ok(packageJson.build.extraResources.some((resource: { from: string; to: string }) =>
    resource.from === 'assets/logos/vast.png' && resource.to === 'app-wordmark.png'))
})

test('splash document keeps the cropped, centered logo treatment', () => {
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

test('splash animation avoids large blur filters that lower launch FPS', () => {
  assert.doesNotMatch(documentSource, /filter:\s*blur\(/)
})

test('splash paints its opaque background immediately with no baked-in overlay animation', () => {
  assert.match(overlayRule, /linear-gradient\(180deg,\s*#030406/)
  assert.match(overlayRule, /width:\s*100vw;/)
  assert.match(overlayRule, /height:\s*100vh;/)
  assert.match(overlayRule, /border-radius:\s*0;/)
  assert.doesNotMatch(documentSource, /animation:\s*vast-opening-overlay/)
})

test('splash logo glow stays high resolution dark purple instead of white', () => {
  assert.match(haloRule, /width:\s*min\(64vw,\s*56rem\);/)
  assert.match(haloRule, /rgba\(91,\s*64,\s*168,/)
  assert.match(haloRule, /rgba\(38,\s*24,\s*74,/)
  assert.doesNotMatch(haloRule, /rgba\(255,\s*255,\s*255,/)
})

test('the splash timeline settles, reveals, then holds its calm state for the reveal', () => {
  assert.match(documentSource, /@keyframes vast-opening-backdrop \{\s*0% \{ opacity: 0; \}\s*9\.3%, 100% \{ opacity: 1; \}/)
  assert.match(documentSource, /@keyframes vast-opening-logo \{\s*0%, 9\.3% \{ opacity: 0;/)
  assert.match(documentSource, /37%, 77\.8% \{ opacity: 1; transform: translateY\(0\) scale\(1\); \}/)
  assert.match(documentSource, /100% \{ opacity: 1; transform: translateY\(0\) scale\(1\); \}/)
  assert.match(documentSource, /@media \(prefers-reduced-motion: reduce\)/)
})
