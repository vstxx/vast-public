import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/components/${path}`, import.meta.url), 'utf8')

test('deleting a note asks for a danger confirmation first', () => {
  const sidePanel = read('side-panel/SidePanel.tsx')
  assert.match(sidePanel, /if \(await confirm\(`Delete “\$\{note\.title \|\| 'Untitled note'\}”\?`, 'This note will be deleted\.', 'Delete', \{ danger: true \}\)\) deleteNote\(note\.id\)/)
  const notesPage = read('notes/NotesPage.tsx')
  const removeSelected = notesPage.slice(notesPage.indexOf('const removeSelected = '), notesPage.indexOf('const createNote = '))
  assert.ok(removeSelected.indexOf("{ danger: true }") > -1 && removeSelected.indexOf('{ danger: true }') < removeSelected.indexOf('deleteNote('), 'confirm runs before deleteNote')
})
