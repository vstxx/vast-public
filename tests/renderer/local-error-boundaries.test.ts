import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const stageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const internalRouterSource = readFileSync(new URL('../../src/renderer/components/browser/InternalPageRouter.tsx', import.meta.url), 'utf8')
const boundarySource = readFileSync(new URL('../../src/renderer/components/ui/LocalErrorBoundary.tsx', import.meta.url), 'utf8')

test('lazy overlays have dismissible local error boundaries', () => {
  for (const name of ['Sidebar', 'Command palette', 'Settings']) {
    assert.match(appSource, new RegExp(`<LocalErrorBoundary name="${name}" overlay onDismiss=`))
  }
  assert.doesNotMatch(boundarySource, /location\.reload/)
  assert.match(boundarySource, /Try again/)
})

test('internal Vast pages render inside a per-tab local error boundary', () => {
  assert.match(internalRouterSource, /<LocalErrorBoundary key=\{`\$\{tab\.id\}:\$\{tab\.url\}`\}/)
  assert.match(internalRouterSource, /<Suspense fallback=\{<InternalPageFallback \/>\}>/)
  assert.match(internalRouterSource, /\{page\}/)
})
