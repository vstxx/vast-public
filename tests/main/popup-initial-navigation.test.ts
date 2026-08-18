import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldLoadPopupInitialUrl } from '../../src/main/windows/popup-initial-navigation.ts'

const safe = (url: string): boolean => url.startsWith('https://')

test('popup without Chromium-provided webContents loads a direct safe initial URL', () => {
  assert.equal(shouldLoadPopupInitialUrl('https://accounts.google.com/o/oauth2/auth', false, safe), true)
})

test('popup preserves Chromium navigation for provided webContents and about:blank flows', () => {
  assert.equal(shouldLoadPopupInitialUrl('https://accounts.google.com/o/oauth2/auth', true, safe), false)
  assert.equal(shouldLoadPopupInitialUrl('about:blank', false, safe), false)
  assert.equal(shouldLoadPopupInitialUrl('javascript:alert(1)', false, safe), false)
})
