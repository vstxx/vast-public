import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = read('styles/index.css')

// Every text field highlights like the focused address bar, at the same speed.
test('text fields share the address bar focus border, ring and 150ms timing', () => {
  const fieldSelector = ":is(input:is(:not([type]), [type='text'], [type='search'], [type='url'], [type='email'], [type='password'], [type='number'], [type='tel']), textarea):not(.address-bar-input):not(.command-palette-input):not(.bg-transparent)"
  assert.ok(css.includes(`${fieldSelector},\n.settings-search-panel,\n.extensions-search-field {\n  transition-property: color, background-color, border-color, box-shadow, opacity;\n  transition-duration: 150ms;`))
  assert.ok(css.includes(`${fieldSelector}:focus,\n.settings-search-panel:focus-within,\n.extensions-search-field:focus-within {\n  border-color: var(--vast-field-focus-border) !important;\n  box-shadow: var(--vast-field-focus-ring) !important;\n  outline: none !important;`))
  // Same values as the address bar's own focus rules.
  assert.match(css, /--vast-field-focus-border: color-mix\(in srgb, var\(--vast-accent\) var\(--vast-address-border-mix\), transparent\);/)
  assert.match(css, /\.app-shell\.dim-theme \{\n  --vast-field-focus-border: color-mix\(in srgb, var\(--vast-accent\) 30%, rgba\(255, 255, 255, 0\.14\)\);/)
  assert.match(css, /\.dim-theme \.vast-top-address:focus-within \{\n  border-color: color-mix\(in srgb, var\(--vast-accent\) 30%, rgba\(255, 255, 255, 0\.14\)\);/)
})

test('vertical tab rows line up with workspace rows', () => {
  const row = read('components/tabs/TabRow.tsx')
  assert.doesNotMatch(row, /GripVertical/)
  assert.match(row, /<span className=\{`grid h-6 w-6 shrink-0 place-items-center \$\{compact \? '' : 'mr-1'\}`\}>\s*<Favicon/)
  assert.match(read('components/tabs/Sidebar.tsx'), /overflow-y-auto \$\{showCompactContents \? 'vertical-tabs-scroll-compact w-16 shrink-0 px-2' : 'pl-4 pr-1\.5'\}/)
  // An unlayered rule: a Tailwind utility would lose to the global overflow gutter rule.
  assert.match(css, /\.vertical-tabs-scroll-compact\.vertical-tabs-scroll-compact \{\n  scrollbar-gutter: auto;/)
})
