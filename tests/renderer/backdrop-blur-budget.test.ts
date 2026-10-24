import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = read('styles/index.css')
const purist = read('components/purist/purist.css')

// Collects the declarations of every top-level rule whose selector list contains `selector` exactly.
function declarationsFor(source: string, selector: string): string[] {
  const bodies: string[] = []
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let match = rule.exec(stripped); match; match = rule.exec(stripped)) {
    const selectors = match[1].split(',').map((item) => item.trim())
    if (selectors.includes(selector)) bodies.push(match[2])
  }
  return bodies
}
const blurs = (source: string, selector: string): boolean =>
  declarationsFor(source, selector).some((body) =>
    [...body.matchAll(/(?:^|[\s;])backdrop-filter:\s*([^;]+)/g)].some((match) => !/^none\b/.test(match[1].trim())))

test('surfaces that are opaque in every theme do not pay for a backdrop blur', () => {
  for (const selector of ['.horizontal-chrome', '.vast-top-address', '.vast-glass-panel', '.vast-button', '.vast-select-menu', '.extensions-tablist', "[role='menu']"]) {
    assert.equal(blurs(css, selector), false, `${selector} should not declare a backdrop blur`)
  }
  assert.doesNotMatch(read('components/horizontal/HorizontalChrome.tsx'), /<header className="horizontal-chrome[^"]*backdrop-blur/)
  assert.doesNotMatch(read('components/browser/AddressBar.tsx'), /vast-top-address group[^`]*backdrop-blur/)
})

// Floating surfaces get Transparency and Frost from one rule; nothing nested
// inside them adds a second blur.
test('floating surfaces share the Frost rule; their contents do not blur again', () => {
  const floating = 'html .vast-float.vast-float,\nhtml .side-panel.side-panel,\nhtml .vast-select-menu.vast-select-menu,\nhtml .settings-hint.settings-hint {'
  const start = css.indexOf(floating)
  assert.ok(start > -1)
  const body = css.slice(start, css.indexOf('}', start))
  assert.match(body, /background: color-mix\(in srgb, var\(--vast-float-surface\) var\(--vast-float-opacity\), transparent\) !important;/)
  assert.match(body, /backdrop-filter: var\(--vast-float-filter\) !important;/)
  assert.equal(blurs(css, '.side-panel .vast-button'), false)
  assert.equal(blurs(css, ".extensions-toolbar-menu [role='menu']"), false)
  assert.equal(blurs(purist, '.address-bar-purist .vast-top-address-purist'), true, 'the purist address bar is translucent')
})

test('popovers inside the opaque header keep their historical (unblurred) rendering', () => {
  const body = declarationsFor(css, '.horizontal-chrome .backdrop-blur-xl').join('')
  assert.match(body, /backdrop-filter:\s*none/)
  assert.deepEqual(declarationsFor(css, '.horizontal-chrome .backdrop-blur-2xl').length, 1)
})

test('dialog blurs stay inline because the minified CSS keeps only the -webkit- copy', () => {
  assert.match(read('components/settings/SettingsModal.tsx'), /overlayStyle=\{\{ backdropFilter:/)
  const palette = read('components/command-palette/CommandPalette.tsx')
  assert.match(palette, /style=\{\{ backdropFilter: [^}]+\}\} className="command-palette-shell/)
})

// The overlay already blurs the page; a second blur on the ~82% opaque panel
// doubled the GPU cost of every frame drawn behind Settings and the palette.
test('Settings and the command palette do not nest a panel blur over the overlay blur', () => {
  assert.doesNotMatch(read('components/settings/SettingsModal.tsx'), /panelStyle=\{\{ backdropFilter:/)
  assert.doesNotMatch(read('components/command-palette/CommandPalette.tsx'), /backdropFilter: [^}]+\}\} className="command-palette-panel/)
  assert.doesNotMatch(declarationsFor(css, '.settings-modal-shell').join(''), /backdrop-filter:[^;]*blur\(/)
  assert.doesNotMatch(declarationsFor(css, '.command-palette-panel').join(''), /backdrop-filter:[^;]*blur\(/)
})
