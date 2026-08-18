import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(new URL(`../../src/renderer/components/${path}`, import.meta.url), 'utf8')
}

const notesSource = source('notes/NotesPage.tsx')
const passwordsSource = source('passwords/PasswordsPage.tsx')
const automationSource = source('automation/AutomationPage.tsx')
const avidaeSource = source('avidae/AvidaePage.tsx')
const diagnosticsSource = source('diagnostics/DiagnosticsPage.tsx')
const timelineSource = source('session-timeline/SessionTimelinePage.tsx')
const networkSource = source('network/NetworkPage.tsx')

test('Labs pages do not render decorative eyebrow captions above their headings', () => {
  assert.doesNotMatch(passwordsSource, /Local encrypted vault - no Google sync/)
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

test('Password Manager and Automation action bars keep deliberate equal-column grids', () => {
  assert.match(passwordsSource, /grid w-full grid-cols-2 gap-2 sm:grid-cols-3 lg:w-\[33rem\]/)
  assert.match(passwordsSource, /data-testid="password-entry-actions"/)
  assert.match(passwordsSource, /md:grid-cols-4/)
  assert.match(automationSource, /className="mt-3 grid grid-cols-4 gap-2" data-testid="automation-primary-actions"/)
  assert.match(automationSource, /vault-danger-button mt-2 w-full justify-center/)
})

test('remaining Labs primary actions have explicit symmetric layouts', () => {
  assert.match(avidaeSource, /data-testid="avidae-primary-actions"/)
  assert.match(avidaeSource, /sm:grid-cols-3/)
  assert.match(diagnosticsSource, /data-testid="diagnostics-primary-actions"/)
  assert.match(timelineSource, /data-testid="timeline-primary-actions"/)
  assert.match(networkSource, /grid w-full grid-cols-2 gap-2 sm:w-auto lg:w-52 lg:grid-cols-1/)
})
