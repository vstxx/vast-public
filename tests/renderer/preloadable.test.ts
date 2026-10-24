import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement, Suspense } from 'react'
import { renderToString } from 'react-dom/server'
import { preloadable } from '../../src/renderer/lib/preloadable.ts'

const Panel = (): ReturnType<typeof createElement> => createElement('div', null, 'panel ready')
const render = (Component: Parameters<typeof createElement>[0]): string =>
  renderToString(createElement(Suspense, { fallback: createElement('i', null, 'fallback') }, createElement(Component)))

test('a preloaded component renders on its first render without suspending', async () => {
  let imports = 0
  const panel = preloadable(async () => { imports++; return { default: Panel } })
  await panel.preload()
  await panel.preload()
  assert.equal(imports, 1, 'the module is imported once')
  assert.match(render(panel.Component), /panel ready/)
  assert.doesNotMatch(render(panel.Component), /fallback/)
})

test('opening before the preload finishes behaves like a plain lazy component', () => {
  const panel = preloadable(() => new Promise<{ default: typeof Panel }>(() => undefined))
  assert.match(render(panel.Component), /fallback/)
})

test('a failed preload does not poison the first open', async () => {
  let attempts = 0
  const panel = preloadable(async () => {
    attempts++
    if (attempts === 1) throw new Error('chunk temporarily unavailable')
    return { default: Panel }
  })
  await assert.rejects(panel.preload())
  await panel.preload()
  assert.equal(attempts, 2)
  assert.match(render(panel.Component), /panel ready/)
})

test('Settings and the side panel are preloaded once the browser is idle after startup', () => {
  const app = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /const settingsModal = preloadable\(\(\) => import\('\.\.\/components\/settings\/SettingsModal'\)/)
  assert.match(app, /const sidePanel = preloadable\(\(\) => import\('\.\.\/components\/side-panel\/SidePanel'\)/)
  assert.match(app, /requestIdleCallback\(\(\) => \{[\s\S]*?settingsModal\.preload\(\)[\s\S]*?sidePanel\.preload\(\)/)
})
