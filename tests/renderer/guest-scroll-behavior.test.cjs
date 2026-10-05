const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../../src/preload/guest.ts'), 'utf8')
const bundle = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function guestHarness() {
  class MockElement {
    constructor(parentElement = null) {
      this.parentElement = parentElement
      this.scrollHeight = 1000
      this.clientHeight = 200
      this.scrollTop = 0
    }
  }
  const root = new MockElement()
  const listeners = new Map()
  const frames = []
  const messages = []
  const document = {
    readyState: 'complete', scrollingElement: root,
    addEventListener(name, listener) {
      const list = listeners.get(name) || []
      list.push(listener)
      listeners.set(name, list)
    }
  }
  const window = {
    scrollY: 0, innerHeight: 800,
    addEventListener() {},
    requestAnimationFrame(callback) { frames.push(callback); return frames.length }
  }
  vm.runInNewContext(bundle, {
    exports: {}, document, window, Element: MockElement,
    location: { href: 'https://example.test/', protocol: 'https:' },
    process: { isMainFrame: false },
    require(id) {
      if (id === 'electron/renderer') return { ipcRenderer: { sendSync: () => null, sendToHost: (...args) => messages.push(args) } }
      if (id === '../shared/spoofing') return {}
      throw new Error(`Unexpected import ${id}`)
    }
  })
  const fire = (name, event) => { for (const listener of listeners.get(name) || []) listener(event) }
  const flush = () => { while (frames.length) frames.shift()() }
  flush()
  return { MockElement, root, messages, fire, flush }
}

test('upward wheel in an inner list does not reveal Purist while an ancestor can scroll upward', () => {
  const guest = guestHarness()
  const parent = new guest.MockElement(guest.root)
  parent.scrollTop = 80
  const child = new guest.MockElement(parent)
  guest.fire('wheel', { deltaY: -10, deltaMode: 0, target: child })
  guest.fire('wheel', { deltaY: -10, deltaMode: 0, target: child })
  assert.equal(guest.messages.some(([channel, action]) => channel === 'vast:purist-top-overscroll' && action === 'show'), false)
})

test('scrolling down hides visible Purist overscroll even if the boundary state was already false', () => {
  const guest = guestHarness()
  const child = new guest.MockElement(guest.root)
  child.scrollTop = 20
  guest.fire('scroll', { target: child })
  guest.flush()
  child.scrollTop = 0
  guest.fire('wheel', { deltaY: -20, deltaMode: 0, target: child })
  child.scrollTop = 20
  guest.fire('scroll', { target: child })
  guest.flush()
  assert.deepEqual(guest.messages.filter(([channel]) => channel === 'vast:purist-top-overscroll').map(([, action]) => action), ['show', 'hide'])
})

test('line-mode wheel deltas use pixel-equivalent distance for Purist threshold', () => {
  const guest = guestHarness()
  guest.fire('wheel', { deltaY: -2, deltaMode: 1, target: guest.root })
  assert.equal(guest.messages.some(([channel, action]) => channel === 'vast:purist-top-overscroll' && action === 'show'), true)
})

test('page-mode wheel deltas use the viewport height', () => {
  const guest = guestHarness()
  guest.fire('wheel', { deltaY: -0.03, deltaMode: 2, target: guest.root })
  assert.equal(guest.messages.some(([channel, action]) => channel === 'vast:purist-top-overscroll' && action === 'show'), true)
})

test('upward wheel does not read layout-dependent scroll dimensions', () => {
  const guest = guestHarness()
  const child = new guest.MockElement(guest.root)
  Object.defineProperty(child, 'scrollHeight', { get() { throw new Error('forced layout read') } })
  Object.defineProperty(child, 'clientHeight', { get() { throw new Error('forced layout read') } })
  assert.doesNotThrow(() => guest.fire('wheel', { deltaY: -25, deltaMode: 0, target: child }))
})
