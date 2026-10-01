import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const stageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const webviewSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const guestPreloadSource = readFileSync(new URL('../../src/preload/guest.ts', import.meta.url), 'utf8')

test('guest preload never registers a scroll-blocking wheel listener', () => {
  const wheelListeners: Array<{ passive?: boolean }> = []
  const guestBundle = ts.transpileModule(guestPreloadSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(guestBundle, {
    exports: {},
    require: (id: string) => {
      if (id === 'electron/renderer') return { ipcRenderer: { sendSync: () => null, sendToHost: () => undefined } }
      if (id === '../shared/spoofing') return {}
      throw new Error(`Unexpected preload import: ${id}`)
    },
    document: {
      readyState: 'loading',
      addEventListener: (name: string, _listener: unknown, options?: { passive?: boolean }) => {
        if (name === 'wheel') wheelListeners.push(options ?? {})
      }
    },
    window: { addEventListener: () => undefined },
    location: { href: 'https://example.test/', protocol: 'https:' },
    process: { isMainFrame: false }
  })
  assert.ok(wheelListeners.length > 0, 'the passive overscroll listener must remain installed')
  assert.ok(wheelListeners.every((options) => options.passive === true), 'all guest wheel listeners must be passive')
})

test('Ctrl+wheel zooms the hovered internal pane and applies its stored zoom', () => {
  assert.match(appSource, /event\.composedPath\(\)[\s\S]*item\.dataset\.tabId/)
  assert.match(appSource, /runtime\.adjustZoom\([^\n]+pane\?\.dataset\.tabId\)/)
  assert.match(stageSource, /className="internal-page-zoom-surface"/)
  assert.match(stageSource, /width: `\$\{100 \/ tab\.zoom\}%`/)
  assert.match(stageSource, /transform: `scale\(\$\{tab\.zoom\}\)`/)
  assert.match(stageSource, /transformOrigin: 'top left'/)
  assert.doesNotMatch(stageSource, /zoom: tab\.zoom/)
  assert.match(stylesSource, /\.internal-page-zoom-surface\s*\{[^}]*position:\s*absolute[^}]*overflow:\s*auto/s)
})
