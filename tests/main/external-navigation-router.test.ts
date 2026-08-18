import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { BrowserWindow } from 'electron/main'

import {
  ExternalNavigationRouter,
  externalNavigationTarget,
  externalNavigationTargets
} from '../../src/main/windows/ExternalNavigationRouter.ts'
import type { WindowRegistry } from '../../src/main/windows/WindowRegistry.ts'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')

test('external URL parser accepts HTTP(S), spaces, Unicode, long URLs, and quoted Windows arguments', () => {
  assert.equal(externalNavigationTarget('"https://example.com/a path?q=hello world"'), 'https://example.com/a%20path?q=hello%20world')
  assert.equal(externalNavigationTarget('https://żółw.example/ścieżka'), 'https://xn--w-uga1v8h.example/%C5%9Bcie%C5%BCka')
  const longUrl = `https://example.com/${'a'.repeat(32_000)}`
  assert.equal(externalNavigationTarget(longUrl), longUrl)
  assert.deepEqual(externalNavigationTargets(['Vast.exe', '--flag', 'https://one.example/', '"https://two.example/a b"']), [
    'https://one.example/',
    'https://two.example/a%20b'
  ])
})

test('external URL parser rejects unsafe schemes and limits the public vast protocol', () => {
  for (const input of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,test', 'ftp://example.com/file', 'vast://passwords']) {
    assert.equal(externalNavigationTarget(input), undefined, input)
  }
  assert.equal(externalNavigationTarget('vast://newtab'), 'vast://newtab')
  assert.equal(
    externalNavigationTarget(`vast://open?url=${encodeURIComponent('https://example.com/auth?state=a b')}`),
    'https://example.com/auth?state=a%20b'
  )
  assert.equal(externalNavigationTarget(`vast://open?url=${encodeURIComponent('file:///C:/secret.txt')}`), undefined)
})

test('rapid distinct links are delivered while duplicate startup events are collapsed', () => {
  const delivered: string[] = []
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => undefined,
    focus: () => undefined,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, request: { url: string }) => delivered.push(request.url)
    }
  } as unknown as BrowserWindow
  const registry = {
    focusedVastWindow: () => window,
    isRendererReady: () => true,
    markRendererReady: () => undefined
  } as unknown as WindowRegistry
  const router = new ExternalNavigationRouter(registry, () => window)
  router.acceptUrl('https://one.example/')
  router.acceptUrl('https://one.example/')
  router.acceptUrl('https://two.example/')
  router.acceptUrl('https://three.example/')
  assert.deepEqual(delivered, ['https://one.example/', 'https://two.example/', 'https://three.example/'])
})

test('main process owns single-instance, second-instance, and macOS open-url routing', () => {
  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/)
  assert.match(mainSource, /app\.on\('second-instance'/)
  assert.match(mainSource, /app\.on\('open-url'/)
  assert.match(mainSource, /externalNavigationRouter\.acceptArguments\(process\.argv\)/)
})
