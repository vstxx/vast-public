import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8')

test('bookmarks bar remeasures when visibility is toggled back on', () => {
  assert.match(source, /}, \[orderedItems\.length, visible, onlyOnNewTab, activeTabUrl\]\)/)
  assert.match(source, /calculateVisibleBookmarkCount\(\{ barWidth, itemWidths \}\)/)
})

test('bookmarks bar can be limited to New Tab and replaces that tab when opening a bookmark', () => {
  assert.match(source, /onlyOnNewTab && activeTabUrl !== INTERNAL_NEW_TAB_URL/)
  assert.match(source, /activeTabUrl === INTERNAL_NEW_TAB_URL && !replacedNewTabRef\.current/)
  assert.match(source, /runtime\.navigateActive\(url\)/)
})

test('bookmarks bar measures hidden overflow items from a stable width cache', () => {
  assert.match(source, /itemWidthCacheRef/)
  assert.match(source, /data-bookmark-key/)
  assert.match(source, /orderedItemKeys\.map\(\(key\) => itemWidthCacheRef\.current\.get\(key\) \?\? 0\)/)
})
