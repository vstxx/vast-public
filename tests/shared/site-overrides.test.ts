import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  buildSiteOverrideScript,
  isSiteOverrideDisabled,
  siteOverrideForUrl
} from '../../src/shared/site-overrides.ts'

test('IDU site override matches only s19.idu.edu.pl web pages', () => {
  assert.equal(siteOverrideForUrl('https://s19.idu.edu.pl/')?.id, 'idu-modern')
  assert.equal(siteOverrideForUrl('https://s19.idu.edu.pl/uczen/wiadomosci')?.id, 'idu-modern')
  assert.equal(siteOverrideForUrl('http://s19.idu.edu.pl/login')?.id, 'idu-modern')
  assert.equal(siteOverrideForUrl('https://example.com/'), undefined)
  assert.equal(siteOverrideForUrl('https://s20.idu.edu.pl/'), undefined)
})

test('site override disabled state is stored by override id', () => {
  assert.equal(isSiteOverrideDisabled({ disabled: { 'idu-modern': true } }, 'idu-modern'), true)
  assert.equal(isSiteOverrideDisabled({ disabled: { 'idu-modern': false } }, 'idu-modern'), false)
  assert.equal(isSiteOverrideDisabled({ disabled: {} }, 'idu-modern'), false)
})

test('site override script can apply and remove the IDU skin', () => {
  const override = siteOverrideForUrl('https://s19.idu.edu.pl/')
  assert.ok(override)

  const applyScript = buildSiteOverrideScript(override, true)
  assert.match(applyScript, /__vast_site_override_idu-modern/)
  assert.match(applyScript, /vast-site-override-idu-modern/)
  assert.match(applyScript, /document\.head\.appendChild\(style\)/)

  const removeScript = buildSiteOverrideScript(override, false)
  assert.match(removeScript, /existing\.remove\(\)/)
  assert.match(removeScript, /classList\.remove/)
})

test('IDU skin improves typography, icons, controls, and rounded sections without layout rewrite', () => {
  const override = siteOverrideForUrl('https://s19.idu.edu.pl/')
  assert.ok(override)
  const css = override.css

  assert.match(css, /font-family:\s*Inter,\s*"Inter"/)
  assert.match(css, /border-radius:\s*10px !important/)
  assert.match(css, /table/)
  assert.match(css, /fieldset/)
  assert.match(css, /div\[style\*="border" i\]/)
  assert.match(css, /data:image\/svg\+xml/)
  assert.match(css, /a\[href\*="wiadom" i\] img/)
  assert.match(css, /a\[href\*="forum" i\] img/)
  assert.match(css, /input:not\(\[type="checkbox"\]\)/)
  assert.match(css, /textarea/)
  assert.match(css, /button/)
  assert.match(css, /\[class\*="plan" i\] td/)
  assert.match(css, /\[class\*="lekcj" i\] td/)
  assert.match(css, /\[id\*="naglow" i\]/)
  assert.match(css, /body > table:first-of-type:has\(img\[src\*="idu" i\]\)/)
  assert.match(css, /white-space:\s*nowrap/)
  assert.match(css, /max-height:\s*46px/)
  assert.match(css, /padding-top:\s*6px/)
  assert.match(css, /line-height:\s*1\.18/)

  assert.doesNotMatch(css, /color-scheme/)
  assert.doesNotMatch(css, /color:/)
  assert.doesNotMatch(css, /box-shadow/)
  assert.doesNotMatch(css, /grid-template-columns/)
  assert.doesNotMatch(css, /display:\s*grid/)
  assert.doesNotMatch(css, /MutationObserver/)
  assert.doesNotMatch(css, /vast-idu-card/)
  assert.equal('enhancementScript' in override, false)
})
