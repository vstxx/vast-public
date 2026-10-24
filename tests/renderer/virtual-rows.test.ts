import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

// Node cannot import .tsx; bundle the real component (React stays external).
const require = createRequire(import.meta.url)
const Module = require('node:module')
const entry = fileURLToPath(new URL('../../src/renderer/components/ui/VirtualRows.tsx', import.meta.url))
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', write: false, logLevel: 'silent' }).outputFiles[0].text
const compiled = new Module(entry)
compiled.filename = entry
compiled.paths = Module._nodeModulePaths(dirname(entry))
compiled._compile(code, entry)
const VirtualRows = compiled.exports.VirtualRows

type Row = { id: string }
const items: Row[] = Array.from({ length: 5_000 }, (_, index) => ({ id: `row-${index}` }))
const getKey = (row: Row): string => row.id
const estimate = (): number => 44

test('only rows near the viewport are mounted, while the list keeps its full height', () => {
  const html = renderToString(createElement(VirtualRows, { items, getKey, estimateHeight: estimate, renderRow: (row: Row) => createElement('span', null, row.id) }))
  const mounted = html.match(/data-virtual-key=/g)?.length ?? 0
  assert.ok(mounted > 0 && mounted < 100, `mounted ${mounted} rows`)
  assert.match(html, /height:220000px/)
  assert.match(html, />row-0</)
  assert.doesNotMatch(html, />row-4999</)
})

test('row spacing is part of each row so measured heights include it', () => {
  const html = renderToString(createElement(VirtualRows, { items: items.slice(0, 3), getKey, estimateHeight: estimate, rowGap: () => 12, renderRow: (row: Row) => createElement('span', null, row.id) }))
  assert.equal(html.match(/padding-bottom:12px/g)?.length, 3)
})

test('the bookmarks and history panels are virtualized', () => {
  const panel = readFileSync(new URL('../../src/renderer/components/side-panel/SidePanel.tsx', import.meta.url), 'utf8')
  const bookmarks = panel.slice(panel.indexOf('function BookmarksPanel('), panel.indexOf('function FolderNameEditor('))
  const history = panel.slice(panel.indexOf('function HistoryPanel('), panel.indexOf('function DownloadsPanel('))
  assert.match(bookmarks, /<VirtualRows items=\{rows\}/)
  assert.doesNotMatch(bookmarks, /bookmarks\.filter\(\(bookmark\) => bookmark\.folderId === folder\.id/, 'no per-folder scan of every bookmark')
  assert.match(history, /<VirtualRows items=\{filteredHistory\}/)
})
