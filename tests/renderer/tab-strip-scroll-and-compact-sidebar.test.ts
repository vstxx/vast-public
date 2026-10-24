import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const chrome = read('components/horizontal/HorizontalChrome.tsx')
const css = read('styles/index.css')

test('every tab renders in the strip, which scrolls once tabs reach their minimum width', () => {
  assert.match(chrome, /\{workspaceTabs\.map\(\(tab, index\) => \(/)
  assert.doesNotMatch(chrome, /visibleCapacity|overflowTabs/)
  assert.match(chrome, /const overflowing = tabCount \* \(minimumTabWidth \+ tabGap\) \+ separatorWidth > stripWidth - newTabButtonWidth/)
  assert.match(chrome, /className="horizontal-tab-strip no-drag relative flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden py-1"/)
  // Offscreen tabs skip rendering work.
  assert.match(chrome, /style=\{\{ width, contentVisibility: 'auto', containIntrinsicSize: `\$\{width\}px 40px` \}\}/)
})

test('the wheel scrolls the strip without ever blocking the compositor', () => {
  assert.match(chrome, /strip\.addEventListener\('wheel', onWheel, \{ passive: true \}\)/)
  assert.match(chrome, /Math\.abs\(event\.deltaX\) >= Math\.abs\(event\.deltaY\)\) return/, 'horizontal gestures stay native')
  assert.match(chrome, /const notch = event\.deltaMode !== 0 \|\| Math\.abs\(event\.deltaY\) >= 50/)
  assert.match(chrome, /const from = scrollTargetRef\.current \?\? strip\.scrollLeft/, 'quick notches add up instead of restarting')
})

test('the active tab glides into view; edges fade while there is more to scroll', () => {
  assert.match(chrome, /revealActiveTab\(!firstPlacement && smoothScroll\)/)
  assert.match(chrome, /if \(revealPendingRef\.current\) \{/)
  assert.match(css, /@property --vast-tab-fade-left \{\n  syntax: '<length>';/)
  assert.match(css, /\.horizontal-tab-strip\[data-overflowing\] \{[^}]*mask-image: linear-gradient\(90deg, transparent 0, #000 var\(--vast-tab-fade-left\)/s)
  assert.match(css, /transition: --vast-tab-fade-left 160ms ease, --vast-tab-fade-right 160ms ease;/)
  assert.match(chrome, /title="All tabs"/)
})

test('compact sidebar items are one kind of 40px tile', () => {
  assert.match(read('components/tabs/Sidebar.tsx'), /<IconButton className="sidebar-tile" tooltip="Expand sidebar"/)
  assert.match(read('components/tabs/Sidebar.tsx'), /<IconButton className="sidebar-tile" tooltip="New tab"/)
  assert.match(read('components/tabs/TabRow.tsx'), /sidebar-tile justify-center px-0 \$\{active \? 'is-active' : ''\}/)
  assert.match(read('components/workspaces/WorkspaceSwitcher.tsx'), /sidebar-tile justify-center px-0 \$\{active \? 'is-active' : ''\}/)
  assert.match(css, /html \[data-sidebar-content='compact'\] \.sidebar-tile\.sidebar-tile \{\n  width: 40px !important;/)
})

test('Labs features that are off are grayed out without a badge', () => {
  const addressBar = read('components/browser/AddressBar.tsx')
  assert.doesNotMatch(addressBar, /return 'Off'/)
  assert.match(addressBar, /\$\{unavailable \? 'is-unavailable text-vast-soft! opacity-60' : ''\}/)
  assert.match(css, /\.is-unavailable \.video-audio-source-mark \{\n  color: inherit;/)
})

test('a favicon that fails to load falls back to the letter tile', () => {
  assert.match(read('components/ui/Favicon.tsx'), /if \(favicon && favicon !== failedFavicon\) \{\s+return <img src=\{favicon\} alt="" onError=\{\(\) => setFailedFavicon\(favicon\)\}/)
})
