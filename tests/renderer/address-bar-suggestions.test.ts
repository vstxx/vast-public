import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const addressBar = read('components/browser/AddressBar.tsx')

// After a New Tab page, switching tabs filled the still-focused field with the
// page address; that matched history and left a frosted popover over the page.
test('suggestions open only after the user types', () => {
  assert.match(addressBar, /if \(!focused \|\| !edited \|\| query\.length < 1\) return \[\]/)
  assert.match(addressBar, /setValue\(event\.target\.value\)\n\s*setEdited\(true\)/)
  // The browser filling in the page address resets it.
  assert.match(addressBar, /setValue\(activeTab \? addressValueForTab\(activeTab\.url\) : ''\)\n\s*setEdited\(false\)\n\s*\}, \[activeTab\?\.id, activeTab\?\.url\]\)/)
})

test('switching to a page takes focus out of the address bar; a New Tab keeps it', () => {
  assert.match(addressBar, /if \(activeTab && activeTab\.url !== INTERNAL_NEW_TAB_URL && document\.activeElement === inputRef\.current\) inputRef\.current\?\.blur\(\)\n\s*\}, \[activeTab\?\.id\]\)/)
})

test('startup asks for stored data and the Web Store status at the same time', () => {
  const app = read('app/App.tsx')
  const status = app.indexOf('const cwsNavigationStatus = window.vast.app.cwsNavigationStatus()')
  assert.ok(status > 0 && status < app.indexOf('void window.vast.storage\n      .load()'))
  assert.match(app, /const cwsNavigation = await cwsNavigationStatus/)
})
