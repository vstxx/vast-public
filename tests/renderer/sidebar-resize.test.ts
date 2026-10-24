import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

test('the page area keeps its final size while the vertical sidebar animates', () => {
  const sidebar = read('components/tabs/Sidebar.tsx')
  assert.match(sidebar, /shell\.style\.setProperty\('--vast-stage-final-width', `\$\{stage\.getBoundingClientRect\(\)\.width \+ startWidth - targetWidth\}px`\)/)
  assert.match(sidebar, /shell\.classList\.add\('is-sidebar-resizing'\)/)
  assert.match(sidebar, /event\.propertyName === 'width'\) release\(\)/)
  assert.match(sidebar, /window\.setTimeout\(release, 400\)/, 'released even if transitionend never fires')
  const css = read('styles/index.css')
  assert.match(css, /\.app-shell\.is-sidebar-resizing \.browser-stage \{[^}]*position: absolute;[^}]*right: 0;[^}]*width: var\(--vast-stage-final-width\);/)
})

test('dragging the overlay side panel moves it once per frame without re-rendering', () => {
  const panel = read('components/side-panel/SidePanel.tsx')
  const move = panel.slice(panel.indexOf('const startMove = '), panel.indexOf('const panelHeight = '))
  assert.match(move, /frame = window\.requestAnimationFrame\(placePanel\)/)
  assert.match(move, /panel\.style\.left = `\$\{lastPosition\.x\}px`/)
  assert.doesNotMatch(move.slice(0, move.indexOf('const onUp')), /setPosition\(/, 'no React state update per mouse move')
  assert.match(move, /setPosition\(lastPosition\)\s+updateSettings/, 'final position is committed and saved on release')
})
