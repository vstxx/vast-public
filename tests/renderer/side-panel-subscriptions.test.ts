import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../src/renderer/components/side-panel/SidePanel.tsx', import.meta.url), 'utf8')
const panel = (name: string, next: string): string => source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`))

test('side panels never subscribe to the whole active tab or workspace object', () => {
  // Those objects are replaced on every title, progress, favicon or activation update.
  assert.doesNotMatch(source, /useBrowserStore\(selectActiveTab\)/)
  assert.doesNotMatch(source, /useBrowserStore\(selectActiveWorkspace\)/)
})

test('the bookmarks list does not re-render for active-tab updates', () => {
  const bookmarks = panel('BookmarksPanel', 'FolderNameEditor')
  assert.doesNotMatch(bookmarks, /useBrowserStore\(\(state\) => selectActiveTab/)
  assert.match(bookmarks, /selectActiveTab\(useBrowserStore\.getState\(\)\)\?\.url === INTERNAL_NEW_TAB_URL/)
})

test('notes follow the active URL and workspace, and new notes still capture the active tab', () => {
  const notes = panel('NotesPanel', 'BookmarksPanel')
  assert.match(notes, /useBrowserStore\(\(state\) => selectActiveTab\(state\)\?\.url\)/)
  assert.match(notes, /useBrowserStore\(\(state\) => selectActiveWorkspace\(state\)\?\.id\)/)
  assert.match(notes, /note\.workspaceId === workspaceId \|\| note\.url === activeTabUrl/)
  assert.match(notes, /title: activeTab \? activeTab\.title : 'New note'/)
  assert.match(notes, /url: activeTab\?\.url/)
})
