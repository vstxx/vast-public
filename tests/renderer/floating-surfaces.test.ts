import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// Everything floating over pages or Vast's UI follows Transparency and Frost;
// the shell (sidebar, toolbars) stays solid.
test('floating surfaces use the shared Transparency/Frost class instead of fixed backgrounds', () => {
  const surfaces: Array<[string, number]> = [
    ['components/browser/AddressBar.tsx', 3],
    ['components/horizontal/HorizontalChrome.tsx', 4],
    ['components/ui/ContextMenu.tsx', 1],
    ['components/browser/ExtensionsToolbarMenu.tsx', 1],
    ['components/browser/FindBar.tsx', 1],
    ['components/ui/NotificationsOverlay.tsx', 1]
  ]
  for (const [file, count] of surfaces) {
    const source = read(file)
    assert.equal(source.match(/\bvast-float\b/g)?.length, count, file)
    assert.doesNotMatch(source, /bg-\[#0(?:9|b|c|d)0?[0-9a-f]{3,4}\]\/9[5-8]/, `${file} keeps a fixed near-opaque background`)
  }
  assert.match(read('components/ui/NotificationsOverlay.tsx'), /className=\{`vast-toast pointer-events-auto/)
})

test('dialogs follow Background blur and Transparency without a second blur', () => {
  const modal = read('components/ui/ModalShell.tsx')
  assert.match(modal, /style=\{\{ backdropFilter: 'blur\(var\(--vast-dialog-backdrop-blur\)\)', \.\.\.overlayStyle \}\}/)
  assert.match(modal, /vast-modal-surface overflow-hidden rounded-modal/)
  assert.doesNotMatch(modal, /backdrop-blur-xl|bg-\[#0c0c0c\]/)
})

test('portaled surfaces get the theme and both values from <html>', () => {
  const app = read('app/App.tsx')
  assert.match(app, /root\.dataset\.vastTheme = resolvedTheme/)
  for (const name of ['--vast-float-opacity', '--vast-float-alpha', '--vast-float-filter']) assert.match(app, new RegExp(`root\\.style\\.setProperty\\('${name}'`))
  const css = read('styles/index.css')
  assert.match(css, /html\[data-vast-theme='dim'\] \{\n  --vast-float-surface: #1f1f1f;/)
  assert.match(css, /\.dim-theme aside:not\(\.labs-page-surface aside\):not\(\.vast-glass-panel\):not\(\.side-panel\),/)
})
