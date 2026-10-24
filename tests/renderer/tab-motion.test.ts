import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

test('tab motion measures only when the strip layout changes', () => {
  const motion = read('lib/tab-motion.ts')
  assert.match(motion, /export function useTabMotion<[^>]+>\(tabId: string, layoutKey: string\)/)
  assert.match(motion, /\}, \[tabId, layoutKey\]\)/, 'no dependency-free layout effect that runs on every render')
  assert.doesNotMatch(motion, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/, 'media query is created once')
})

test('every tab strip passes a layout key and re-renders rows when it changes', () => {
  for (const [path, component] of [['components/tabs/TabRow.tsx', 'TabRow'], ['components/horizontal/HorizontalChrome.tsx', 'HorizontalTab'], ['components/purist/PuristChrome.tsx', 'PuristTab']]) {
    const source = read(path)
    assert.match(source, /useTabMotion(<HTMLDivElement>)?\(tab\.id, layoutKey\)/, `${component} hook`)
    assert.match(source, /previous\.layoutKey === next\.layoutKey/, `${component} memo comparator`)
  }
  assert.match(read('components/tabs/Sidebar.tsx'), /layoutKey=\{tabLayoutKey\}/)
  // The horizontal strip's key leaves out tab width: widths ease through CSS.
  assert.match(read('components/horizontal/HorizontalChrome.tsx'), /layoutKey=\{tabMotionKey\}/)
  assert.match(read('components/purist/PuristChrome.tsx'), /layoutKey=\{tabLayoutKey\}/)
})

test('the bookmarks bar does not re-measure on every navigation', () => {
  const chrome = read('components/horizontal/HorizontalChrome.tsx')
  assert.match(chrome, /\}, \[orderedItemKeys, visible, hiddenOnThisPage\]\)/)
  assert.match(chrome, /const \{ orderedItems, orderedItemKeys, orderedItemSignature \} = useMemo\(/)
})
