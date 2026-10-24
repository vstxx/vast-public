import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')

test('the browser stage is part of the initial bundle, not a lazy chunk', () => {
  // A lazy stage renders a Suspense fallback first; React 19 then holds the
  // reveal for up to 300 ms, which delayed the first page load on every launch.
  assert.match(app, /import \{ BrowserStage, type BrowserStageHandle \} from '\.\.\/components\/browser\/BrowserStage'/)
  assert.doesNotMatch(app, /lazy\(\(\) => import\('\.\.\/components\/browser\/BrowserStage'\)/)
})
