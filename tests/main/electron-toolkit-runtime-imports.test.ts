import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const openingSplashUrl = new URL('../../src/main/opening-splash.ts', import.meta.url)

test('main process startup avoids runtime imports from electron toolkit utils', () => {
  for (const source of [mainSource, windowSource]) {
    assert.doesNotMatch(source, /@electron-toolkit\/utils/)
    assert.doesNotMatch(source, /from 'electron'/)
  }
  assert.match(mainSource, /from 'electron\/main'/)
  assert.match(windowSource, /from 'electron\/main'/)
  // The dedicated splash is a second lightweight window by design; it must stay
  // script-free of app/runtime imports and load a self-contained document.
  const splashSource = existsSync(openingSplashUrl) ? readFileSync(openingSplashUrl, 'utf8') : ''
  assert.match(splashSource, /from 'electron\/main'/)
  assert.doesNotMatch(splashSource, /@electron-toolkit\/utils/)
  assert.doesNotMatch(splashSource, /from 'electron'/)
})
