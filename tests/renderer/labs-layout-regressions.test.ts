import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(new URL(`../../src/renderer/components/${path}`, import.meta.url), 'utf8')
}

const notesSource = source('notes/NotesPage.tsx')
const automationSource = source('automation/AutomationPage.tsx')
const avidaeSource = source('avidae/AvidaePage.tsx')
const diagnosticsSource = source('diagnostics/DiagnosticsPage.tsx')
const timelineSource = source('session-timeline/SessionTimelinePage.tsx')
const networkSource = source('network/NetworkPage.tsx')

test('Labs pages do not render decorative eyebrow captions above their headings', () => {
  assert.doesNotMatch(automationSource, />Labs<\/div>/)
  assert.doesNotMatch(avidaeSource, /Labs · local companion process/)
  assert.doesNotMatch(diagnosticsSource, /eyebrow="Diagnostics"/)
  assert.doesNotMatch(timelineSource, /eyebrow="Session Timeline"/)
})

test('Notes actions use two complete equal-column rows instead of wrapping', () => {
  assert.match(notesSource, /data-testid="notes-primary-actions"/)
  assert.match(notesSource, /className="grid grid-cols-4 gap-2" data-testid="notes-primary-actions"/)
  assert.match(notesSource, /className="grid grid-cols-3 gap-2" data-testid="notes-secondary-actions"/)
  assert.match(notesSource, /<Pin className="h-4 w-4" \/>/)
  assert.match(notesSource, /<Trash2 className="h-4 w-4" \/>Delete/)
})

test('Notes list and details collapse to rails so the editor takes the freed width', () => {
  // Three columns whose side tracks shrink to a rail; the editor is the only flexible track.
  assert.match(notesSource, /xl:grid-cols-\[var\(--notes-list\)_minmax\(0,1fr\)_var\(--notes-details\)\]/)
  assert.match(notesSource, /'--notes-list': panels\.list \? '340px' : PANEL_RAIL/)
  assert.doesNotMatch(notesSource, /max-w-7xl/)
  assert.match(notesSource, /data-testid="notes-list-rail"/)
  assert.match(notesSource, /data-testid="notes-details-rail"/)
  assert.match(notesSource, /aria-expanded=\{open\}/)
  // Hidden state is a per-viewer convenience: storage failures must not break the page.
  assert.match(notesSource, /const PANELS_KEY = 'vast:notes-panels'/)
  assert.match(notesSource, /function readPanels\(\): NotesPanels \{\s*try \{/)
  assert.match(notesSource, /function writePanels\(panels: NotesPanels\): void \{\s*try \{/)
  // The column animation honours reduced motion.
  assert.match(notesSource, /transition-\[grid-template-columns\][^"]*motion-reduce:transition-none/)
})

test('Automation action bars keep deliberate equal-column grids', () => {
  assert.match(automationSource, /className="mt-3 grid grid-cols-4 gap-2" data-testid="automation-primary-actions"/)
  assert.match(automationSource, /vast-button--danger vast-button--sm mt-2 w-full justify-center/)
})

test('remaining Labs primary actions have explicit symmetric layouts', () => {
  assert.match(avidaeSource, /data-testid="avidae-primary-actions"/)
  assert.match(avidaeSource, /sm:grid-cols-3/)
  assert.match(diagnosticsSource, /data-testid="diagnostics-primary-actions"/)
  assert.match(timelineSource, /data-testid="timeline-primary-actions"/)
  assert.match(networkSource, /grid w-full grid-cols-2 gap-2 sm:w-auto lg:w-52 lg:grid-cols-1/)
})
