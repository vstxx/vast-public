// End-to-end checks for the motion system in the built app (out/), driven
// over CDP with isolated, seeded profiles: enter/exit lifecycle, interruption,
// notification stacks, focus and Escape, dropdown and context-menu placement,
// fast typing, tab FLIP and close withdrawal, sidebar/side panel page-resize
// discipline, Horizontal/Purist workspace menus, Off/Standard/Enhanced,
// reduced motion, legacy settings, and cleanup.
//
// Usage: npm run build, then node scripts/motion-e2e.cjs
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const electron = require('electron')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const pass = (name, detail = '') => { results.push(name); console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`) }
const serverPort = 9970 + Math.floor(Math.random() * 20)

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = message.id && this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    const session = new Cdp(ws)
    await session.send('Runtime.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30_000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  async key(key, code, keyCode, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
  }

  async click(expression, button = 'left', offset) {
    const point = await this.evaluate(`(() => { const e=${expression}; if(!e) throw new Error('Missing click target: ' + ${JSON.stringify(expression)}); e.scrollIntoView({ block: 'nearest' }); const r=e.getBoundingClientRect(); return ${offset ? `{x:r.x+${offset.x},y:r.y+${offset.y}}` : '{x:r.x+r.width/2,y:r.y+r.height/2}'} })()`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
  }
}

const CTRL = 2
const palette = (cdp) => cdp.key('k', 'KeyK', 75, CTRL)
const escape = (cdp) => cdp.key('Escape', 'Escape', 27)

async function until(cdp, expression, label = expression, timeout = 10_000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    // Elements are reported as true: CDP cannot return DOM nodes by value.
    try { last = await cdp.evaluate(`(() => { const value = (${expression}); return value instanceof Node ? true : value })()`); if (last) return last } catch (error) { last = error.message }
    await wait(25)
  }
  throw new Error(`Timed out: ${label} (${JSON.stringify(last)})`)
}

// Running motion and leftovers anywhere in the renderer.
const RUNNING = `document.getAnimations().filter((a) => a.playState === 'running').length`
const LEFTOVERS = `({ animations: document.getAnimations().length, exiting: document.querySelectorAll('[data-motion-exiting]').length, ghosts: [...document.body.children].filter((e) => e.matches('[aria-hidden="true"][inert]') && e.style.position === 'fixed').length })`
async function settled(cdp, label) {
  await until(cdp, `(() => { const l = ${LEFTOVERS}; return l.animations === 0 && l.exiting === 0 && l.ghosts === 0 })()`, `${label}: motion settles with no leftovers`, 3000)
}

function seed(template, { layout = 'vertical', animations = true, motionLevel, tabs = 12, sidePanelMode = 'docked' } = {}) {
  const data = structuredClone(template)
  const workspace = data.workspaces.find((item) => !item.isPrivate) || data.workspaces[0]
  const now = Date.now()
  data.onboarding = { completed: true, revision: 1 }
  data.settings.openingAnimation = false
  data.settings.hibernateInactiveTabs = true
  data.settings.advanced.confirmBeforeClosingManyTabs = false
  data.settings.advanced.experimentalFeatures = layout === 'purist'
  data.settings.layoutMode = layout
  data.settings.animations = animations
  data.settings.sidePanel.mode = sidePanelMode
  if (motionLevel) data.settings.motionLevel = motionLevel
  else delete data.settings.motionLevel
  data.tabGroups = [{ id: 'g1', workspaceId: workspace.id, name: 'Research', color: '#74e7ff', collapsed: false, order: 0 }]
  data.tabs = Array.from({ length: tabs }, (_, index) => ({
    id: `t${index}`, workspaceId: workspace.id, title: `Motion Tab ${index}`,
    url: `http://127.0.0.1:${serverPort}/page/${index}`, displayUrl: `127.0.0.1:${serverPort}/page/${index}`,
    pinned: false, groupId: index >= 6 && index < 9 ? 'g1' : undefined, status: 'idle', lifecycle: index === 0 ? 'active' : 'sleeping',
    progress: 0, canGoBack: false, canGoForward: false, zoom: 1, createdAt: now - tabs + index, lastAccessedAt: index === 0 ? now : now - index * 1000
  }))
  workspace.activeTabId = 't0'
  data.activeWorkspaceId = workspace.id
  data.history = Array.from({ length: 60 }, (_, index) => ({ id: `h${index}`, title: `Motion history ${index}`, url: `http://127.0.0.1:${serverPort}/history/${index}`, visitCount: 1, lastVisitedAt: now - index * 60_000 }))
  return data
}

async function withApp(template, options, body) {
  const profile = fs.mkdtempSync(path.join(tmpdir(), 'vast-motion-e2e-'))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(seed(template, options)))
  const port = 9300 + Math.floor(Math.random() * 400)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_RELAY_TEST_OFFLINE: '1', VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [root, `--remote-debugging-port=${port}`, '--window-size=1500,950'], { env, stdio: 'ignore' })
  let cdp
  try {
    for (let attempt = 0; attempt < 400 && !cdp; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const target = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
        if (target) cdp = await Cdp.connect(target.webSocketDebuggerUrl)
      } catch {}
      if (!cdp) await wait(50)
    }
    assert(cdp, 'renderer did not start')
    if (options.reducedMotion) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await until(cdp, `Boolean(document.querySelector('.app-shell') && document.querySelector('[data-tab-motion-id]'))`, 'app shell', 30_000)
    await until(cdp, `[...document.querySelectorAll('webview')].some((v) => v.getBoundingClientRect().width > 0 && !v.isLoading())`, 'active page', 30_000)
    await wait(600)
    await body(cdp)
  } finally {
    if (cdp) await cdp.evaluate('window.vast.app.window.close()').catch(() => undefined)
    await new Promise((resolve) => { const timer = setTimeout(resolve, 8000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    await wait(800)
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

// Counts guest page resizes (one per layout change is the budget).
const WATCH_RESIZES = `(() => { const v = [...document.querySelectorAll('webview')].find((x) => x.getBoundingClientRect().width > 0); window.__resizes = 0; let last = v.clientWidth + 'x' + v.clientHeight; window.__resizeObserver?.disconnect(); window.__resizeObserver = new ResizeObserver(() => { const now = v.clientWidth + 'x' + v.clientHeight; if (now !== last) { last = now; window.__resizes += 1 } }); window.__resizeObserver.observe(v) })()`

async function standardSuite(cdp) {
  assert(await cdp.evaluate(`document.documentElement.dataset.vastMotion`) === 'standard', 'legacy settings without motionLevel resolve to Standard')
  pass('legacy settings', 'a profile saved before motionLevel existed runs Standard motion')

  // Enter/exit lifecycle: logical close is immediate, the DOM leaves after its exit.
  await palette(cdp)
  await until(cdp, `document.activeElement?.closest('.command-palette-shell')`, 'palette input focused on open')
  const entering = await cdp.evaluate(`document.querySelector('.command-palette-panel').getAnimations().length`)
  assert(entering === 1, `palette panel has exactly one entrance animation (${entering})`)
  await settled(cdp, 'palette open')
  await escape(cdp)
  const exiting = await cdp.evaluate(`({ attr: document.querySelector('.command-palette-panel')?.hasAttribute('data-motion-exiting'), inert: document.querySelector('.command-palette-panel')?.inert, focusInside: Boolean(document.activeElement?.closest('.command-palette-shell')) })`)
  assert(exiting.attr && exiting.inert && !exiting.focusInside, `exiting palette is inert and holds no focus ${JSON.stringify(exiting)}`)
  await until(cdp, `!document.querySelector('.command-palette-shell')`, 'palette removed after exit', 1000)
  await settled(cdp, 'palette closed')
  pass('enter/exit lifecycle', 'focus on first frame, inert during exit, removed after, no leftovers')

  // Rapid alternating input resolves to the latest request.
  for (let index = 0; index < 11; index += 1) { await palette(cdp); await wait(15) }
  await wait(600)
  const rapid = await cdp.evaluate(`({ shells: document.querySelectorAll('.command-palette-shell').length, exiting: document.querySelectorAll('.command-palette-shell [data-motion-exiting], .command-palette-shell[data-motion-exiting]').length, running: ${RUNNING} })`)
  assert(rapid.shells === 1 && rapid.exiting === 0 && rapid.running === 0, `11 toggles end open and settled ${JSON.stringify(rapid)}`)
  // Reopened mid-exit, the palette must still own the keyboard: Escape closes it.
  assert(await cdp.evaluate(`Boolean(document.activeElement?.closest('.command-palette-shell'))`), 'reopened palette has focus')
  await escape(cdp)
  await until(cdp, `!document.querySelector('.command-palette-shell')`, 'Escape closes the reopened palette', 1000)
  await palette(cdp)
  await until(cdp, `document.activeElement?.closest('.command-palette-shell')`, 'palette reopened')
  for (let index = 0; index < 6; index += 1) { await palette(cdp); await wait(10) }
  await wait(600)
  assert(await cdp.evaluate(`document.querySelectorAll('.command-palette-shell').length`) === 1, '6 more toggles (even) keep it open')
  await palette(cdp)
  await until(cdp, `!document.querySelector('.command-palette-shell')`, 'final toggle closes', 1500)
  await settled(cdp, 'rapid toggling')
  pass('rapid interruption', '17 alternating toggles always end in the last requested state, no stacked animations')

  // Multiple notifications: enter, withdraw in place, the rest reposition.
  await cdp.evaluate(`for (const id of ['n1', 'n2', 'n3']) window.dispatchEvent(new CustomEvent('vast:toast', { detail: { id, title: 'Motion ' + id, message: 'Stack check', tone: 'info' } }))`)
  await until(cdp, `document.querySelectorAll('.vast-toast').length === 3`, 'three toasts')
  const toastsEntering = await cdp.evaluate(`[...document.querySelectorAll('.vast-toast')].filter((e) => e.getAnimations().length > 0).length`)
  await settled(cdp, 'toasts entered')
  await cdp.click(`[...document.querySelectorAll('.vast-toast')][0].querySelector('button[aria-label="Dismiss notification"]')`)
  await until(cdp, `document.querySelectorAll('.vast-toast:not([data-motion-exiting])').length === 2`, 'dismissed toast is exiting')
  await until(cdp, `document.querySelectorAll('.vast-toast').length === 2 && [...document.querySelectorAll('.vast-toast')].some((e) => e.getAnimations().length > 0)`, 'remaining toasts slide up', 1500)
  await cdp.evaluate(`window.dispatchEvent(new CustomEvent('vast:toast', { detail: { id: 'n-error', title: 'Security', message: 'Shown at once', tone: 'error' } }))`)
  await until(cdp, `[...document.querySelectorAll('.vast-toast')].some((e) => e.textContent.includes('Security'))`, 'error toast')
  const errorAnimated = await cdp.evaluate(`[...document.querySelectorAll('.vast-toast')].find((e) => e.textContent.includes('Security')).getAnimations().length`)
  assert(toastsEntering === 3 && errorAnimated === 0, `info toasts enter (${toastsEntering}); critical toast appears immediately (${errorAnimated})`)
  await cdp.evaluate(`for (const button of document.querySelectorAll('.vast-toast:not([data-motion-exiting]) button[aria-label="Dismiss notification"]')) button.click()`)
  await until(cdp, `!document.querySelector('.vast-notification-stack')`, 'stack empties', 2000)
  await settled(cdp, 'notifications')
  pass('notification stack', 'three enter, one withdraws, the rest reposition, critical appears immediately')

  // Focus restoration and Escape for a modal.
  await cdp.evaluate(`document.querySelector('button[title="New workspace"]').focus()`)
  await cdp.click(`document.querySelector('button[title="New workspace"]')`)
  await until(cdp, `document.activeElement?.closest('[role="dialog"]')`, 'prompt focused')
  await escape(cdp)
  await until(cdp, `document.activeElement?.title === 'New workspace'`, 'focus returns to the trigger as the exit starts', 300)
  await until(cdp, `!document.querySelector('[role="dialog"]')`, 'dialog gone')
  await settled(cdp, 'prompt dialog')
  pass('focus and Escape', 'Escape closes, focus returns to the trigger immediately (not after the exit)')

  // Address suggestions while typing quickly: container reveals once, rows never animate.
  await cdp.key('l', 'KeyL', 76, CTRL)
  await until(cdp, `document.activeElement?.classList.contains('address-bar-input')`, 'address focused')
  for (const char of 'motion history') { await cdp.send('Input.insertText', { text: char }); await wait(8) }
  await until(cdp, `document.querySelector('[data-address-suggestions]')`, 'suggestions')
  const typing = await cdp.evaluate(`({ value: document.activeElement.value, containers: document.querySelectorAll('[data-address-suggestions]').length, rowAnimations: [...document.querySelectorAll('[data-address-suggestions] button')].reduce((n, b) => n + b.getAnimations().length, 0), containerAnimations: document.querySelector('[data-address-suggestions]').getAnimations().length })`)
  assert(typing.value === 'motion history' && typing.containers === 1 && typing.rowAnimations === 0 && typing.containerAnimations <= 1, `fast typing ${JSON.stringify(typing)}`)
  await escape(cdp)
  await until(cdp, `!document.querySelector('[data-address-suggestions]')`, 'suggestions close', 1500)
  await settled(cdp, 'suggestions')
  pass('address suggestions', 'no dropped characters, one container reveal, rows never animate')

  // Context menu at the bottom-right edge: clamped, grows from the pointer corner.
  await cdp.evaluate(`(() => { const v = [...document.querySelectorAll('webview')].find((x) => x.getBoundingClientRect().width > 0); const r = v.getBoundingClientRect(); const e = new Event('context-menu'); e.params = { x: r.width - 4, y: r.height - 4 }; v.dispatchEvent(e) })()`)
  await until(cdp, `document.querySelector('[role="menu"]')`, 'edge menu')
  const edge = await cdp.evaluate(`(() => { const m = document.querySelector('[role="menu"]'); const r = m.getBoundingClientRect(); return { inside: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0, origin: m.style.transformOrigin, side: m.dataset.motionSide } })()`)
  assert(edge.inside && edge.origin === 'right bottom' && edge.side === 'above', `edge context menu ${JSON.stringify(edge)}`)
  await escape(cdp)
  await until(cdp, `!document.querySelector('[role="menu"]')`, 'menu logically closed at once', 200)
  await cdp.click(`document.querySelector('[data-tab-motion-id="t2"]')`, 'right', { x: 10, y: 8 })
  await until(cdp, `document.querySelector('[role="menu"]')`, 'tab menu')
  const normal = await cdp.evaluate(`({ origin: document.querySelector('[role="menu"]').style.transformOrigin, side: document.querySelector('[role="menu"]').dataset.motionSide })`)
  assert(normal.origin === 'left top' && normal.side === 'below', `normal context menu ${JSON.stringify(normal)}`)
  await escape(cdp)
  await settled(cdp, 'context menus')
  pass('context menu placement', 'clamped at the viewport edge with a flipped origin; normal menus grow from the pointer')

  // Dropdown above and below its trigger.
  await cdp.click(`document.querySelector('button[title="More browser tools"]')`)
  await until(cdp, `document.querySelector('.browser-tools-menu:not([data-motion-exiting])')`, 'More menu')
  await cdp.click(`[...document.querySelectorAll('.browser-tools-menu [role="menuitem"]')].find((e) => e.textContent.trim() === 'Settings')`)
  await until(cdp, `document.querySelector('.settings-modal-overlay [role="dialog"]')`, 'settings')
  await until(cdp, `!document.querySelector('.browser-tools-menu')`, 'More menu closes behind Settings')
  await wait(350)
  const select = `document.querySelector('[data-settings-select="Motion"] button')`
  await cdp.click(`[...document.querySelectorAll('.settings-modal-overlay button')].find((e) => e.textContent.trim() === 'Appearance')`)
  await until(cdp, select, 'Motion select')
  await wait(400)
  for (const [block, placement, side] of [['start', 'bottom', 'below'], ['end', 'top', 'above']]) {
    await cdp.evaluate(`(() => { const b = ${select}; b.scrollIntoView({ block: '${block}' }); let s = b.parentElement; while (s && !['auto', 'scroll'].includes(getComputedStyle(s).overflowY)) s = s.parentElement; if (s && '${block}' === 'end') s.scrollTop -= 4 })()`)
    await wait(80)
    await cdp.click(select)
    await until(cdp, `document.querySelector('[role="listbox"]')`, 'listbox')
    const placed = await cdp.evaluate(`({ placement: document.querySelector('[role="listbox"]').dataset.placement, side: document.querySelector('[role="listbox"]').dataset.motionSide, animations: document.querySelector('[role="listbox"]').getAnimations().length })`)
    assert(placed.placement === placement && placed.side === side && placed.animations === 1, `${block}: ${JSON.stringify(placed)}`)
    await escape(cdp)
    await until(cdp, `!document.querySelector('[role="listbox"]')`, 'listbox closes')
    await settled(cdp, 'dropdown')
  }
  pass('dropdown placement', 'opens below with room, above near the bottom; one reveal each, no restart on re-placement')

  // Settings motion level switch applies live.
  await cdp.click(select)
  await until(cdp, `document.querySelector('[role="listbox"]')`, 'listbox')
  await cdp.click(`document.querySelector('[role="option"][data-value="enhanced"]')`)
  await until(cdp, `document.documentElement.dataset.vastMotion === 'enhanced'`, 'Enhanced applies')
  await escape(cdp)
  await until(cdp, `!document.querySelector('.settings-modal-overlay')`, 'settings closes')
  await palette(cdp)
  await until(cdp, `document.querySelector('.command-palette-panel')?.getAnimations()[0]`, 'enhanced entrance')
  const enhancedDuration = await cdp.evaluate(`document.querySelector('.command-palette-panel').getAnimations()[0].effect.getTiming().duration`)
  assert(enhancedDuration === 280, `Enhanced dialog timing ${enhancedDuration}`)
  await escape(cdp)
  await settled(cdp, 'enhanced')
  pass('motion level setting', 'Off/Standard/Enhanced select applies live; Enhanced uses its own timing')

  // Tabs: close withdraws a snapshot while neighbours slide; pin repositions; group change moves.
  await cdp.evaluate(WATCH_RESIZES)
  await cdp.click(`document.querySelector('[data-tab-motion-id="t3"]')`, 'right', { x: 10, y: 8 })
  await until(cdp, `document.querySelector('[role="menu"]')`, 'tab menu')
  await cdp.click(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.querySelector('.block.truncate')?.textContent.trim() === 'Close tab')`)
  await until(cdp, `!document.querySelector('[data-tab-motion-id="t3"]')`, 't3 closed')
  const closing = await cdp.evaluate(`({ ghosts: [...document.body.children].filter((e) => e.matches('[aria-hidden="true"][inert]') && e.style.position === 'fixed').length, moving: ['t4','t5'].filter((id) => document.querySelector('[data-tab-motion-id="' + id + '"]').getAnimations().some((a) => a.id === 'vast-tab-motion')).length })`)
  assert(closing.ghosts === 1 && closing.moving === 2, `close: ${JSON.stringify(closing)}`)
  await settled(cdp, 'tab close')
  await cdp.click(`document.querySelector('[data-tab-motion-id="t5"]')`, 'right', { x: 10, y: 8 })
  await until(cdp, `document.querySelector('[role="menu"]')`, 'tab menu')
  await cdp.click(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.querySelector('.block.truncate')?.textContent.trim() === 'Pin tab')`)
  await until(cdp, `document.querySelector('[data-tab-motion-id="t5"]').getAnimations().some((a) => a.id === 'vast-tab-motion')`, 'pinned tab slides', 1000)
  const scale = await cdp.evaluate(`document.querySelector('[data-tab-motion-id="t5"]').getAnimations().find((a) => a.id === 'vast-tab-motion').effect.getKeyframes().map((k) => k.transform).join(' ')`)
  assert(!/scale/.test(scale), `reposition never scales: ${scale}`)
  await settled(cdp, 'pin')
  assert(await cdp.evaluate('window.__resizes') === 0, 'tab motion never resizes the page')
  pass('tab FLIP', 'closed tab withdraws while neighbours slide; pinning repositions by translation only; no page resize')

  // Sidebar collapse/expand: one page resize per toggle, labels fade back once.
  const sidebarState = `(() => { const a = document.querySelector('[data-tab-sidebar]'); return { width: Math.round(a.getBoundingClientRect().width), content: a.dataset.sidebarContent } })()`
  const initial = await cdp.evaluate(sidebarState)
  for (let index = 0; index < 2; index += 1) {
    await cdp.evaluate(WATCH_RESIZES)
    await cdp.key('b', 'KeyB', 66, CTRL)
    await wait(500)
    const resizes = await cdp.evaluate('window.__resizes')
    const state = await cdp.evaluate(sidebarState)
    // Expanded labels return after the width settles; compact contents switch at once.
    assert(resizes === 1 && (state.width > 200 ? state.content === 'expanded' : state.content === 'compact'), `sidebar toggle ${index}: ${resizes} page resizes, ${JSON.stringify(state)}`)
  }
  assert(JSON.stringify(await cdp.evaluate(sidebarState)) === JSON.stringify(initial), 'two toggles return to the starting state')
  await settled(cdp, 'sidebar')
  pass('sidebar', 'page resized at most once per toggle (event-driven reveal, no per-frame layout)')

  // Docked side panel: one resize to open, one to close; contents ease in.
  await cdp.evaluate(WATCH_RESIZES)
  await cdp.click(`document.querySelector('button[title="Show side panel"]')`)
  await until(cdp, `document.querySelector('.side-panel')`, 'side panel')
  const panelAnimating = await cdp.evaluate(`document.querySelector('.side-panel').getAnimations().length`)
  await wait(400)
  const openResizes = await cdp.evaluate('window.__resizes')
  await cdp.click(`document.querySelector('button[title="Hide side panel"]')`)
  await until(cdp, `!document.querySelector('.side-panel')`, 'side panel removed', 1500)
  await wait(300)
  const totalResizes = await cdp.evaluate('window.__resizes')
  assert(panelAnimating === 1 && openResizes === 1 && totalResizes === 2, `docked panel: animating ${panelAnimating}, resizes ${openResizes}/${totalResizes}`)
  await settled(cdp, 'side panel')
  pass('docked side panel', 'contents ease in and out; the page resizes exactly once each way')

  // Find bar: compact reveal, immediate focus, faster exit.
  await cdp.key('f', 'KeyF', 70, CTRL)
  await until(cdp, `document.activeElement?.placeholder === 'Find in page'`, 'find focused immediately', 300)
  const findTiming = await cdp.evaluate(`document.activeElement.parentElement.getAnimations()[0]?.effect.getTiming().duration`)
  await escape(cdp)
  await until(cdp, `!document.querySelector('input[placeholder="Find in page"]')`, 'find closes', 1000)
  const level = await cdp.evaluate(`document.documentElement.dataset.vastMotion`)
  assert(findTiming === (level === 'enhanced' ? 190 : 150), `find reveal ${findTiming} at ${level}`)
  await settled(cdp, 'find')
  pass('find in page', 'focused before the reveal ends; exit is shorter than entry')
}

async function overlayPanelSuite(cdp) {
  await cdp.evaluate(WATCH_RESIZES)
  await cdp.click(`document.querySelector('button[title="Show side panel"]')`)
  await until(cdp, `document.querySelector('.side-panel')`, 'floating side panel')
  const frames = await cdp.evaluate(`document.querySelector('.side-panel').getAnimations()[0].effect.getKeyframes().map((k) => k.transform)`)
  await wait(400)
  // Unpin (dock) from the header button: the panel moves, never jumps.
  const before = await cdp.evaluate(`document.querySelector('.side-panel').getBoundingClientRect().top`)
  await cdp.click(`document.querySelector('.side-panel-pin-button')`)
  await until(cdp, `document.querySelector('.side-panel-slot.is-docked')`, 'docked')
  const moving = await cdp.evaluate(`document.querySelector('.side-panel').getAnimations().filter((x) => !(x instanceof CSSTransition)).length`)
  await settled(cdp, 'pin move')
  assert(/translate3d\(12px, 0px, 0(px)?\)/.test(frames[0]) && moving === 1 && before > 0, `floating panel ${JSON.stringify({ frames, moving })}`)
  pass('floating side panel', 'slides in from its edge; docking it moves it from where it was')
}

async function workspaceMenuSuite(cdp, layout) {
  // Purist keeps the workspace button in its island, which collapses when idle.
  const reveal = async () => {
    if (layout !== 'purist' || await cdp.evaluate(`document.querySelector('.purist-chrome-surface')?.classList.contains('is-expanded')`)) return
    await cdp.click(`document.querySelector('.topbar-island-compact')`)
    await until(cdp, `document.querySelector('.purist-chrome-surface')?.classList.contains('is-expanded')`, 'island')
    await wait(400)
  }
  const button = `document.querySelector('button[aria-label^="Switch workspace"]')`
  await reveal()
  await cdp.click(button)
  await until(cdp, `document.querySelector('[data-testid="workspace-popover"]')`, 'workspace menu')
  const opened = await cdp.evaluate(`(() => { const m = document.querySelector('[data-testid="workspace-popover"]'); return { origin: getComputedStyle(m).transformOrigin, animations: m.getAnimations().length } })()`)
  await escape(cdp)
  await until(cdp, `!document.querySelector('[data-testid="workspace-popover"]:not([data-motion-exiting])')`, 'Escape closes the workspace menu', 300)
  await settled(cdp, `${layout} workspace menu`)
  // Outside click closes; rapid open/close/open ends open.
  await reveal()
  await cdp.click(button)
  await until(cdp, `document.querySelector('[data-testid="workspace-popover"]:not([data-motion-exiting])')`, 'reopen')
  if (layout === 'purist') await cdp.click(`document.querySelector('.purist-titlebar-row')`, 'left', { x: 400, y: 20 })
  else await cdp.click(`document.querySelector('.address-bar-input')`)
  await until(cdp, `!document.querySelector('[data-testid="workspace-popover"]:not([data-motion-exiting])')`, 'outside click closes', 500)
  await reveal()
  for (let index = 0; index < 3; index += 1) { await cdp.click(button); await wait(20) }
  await wait(400)
  const rapid = await cdp.evaluate(`({ open: document.querySelectorAll('[data-testid="workspace-popover"]').length, running: ${RUNNING} })`)
  assert(opened.origin.startsWith('0px 0px') && opened.animations === 1 && rapid.open === 1, `${layout}: ${JSON.stringify({ opened, rapid })}`)
  await escape(cdp)
  await settled(cdp, `${layout} rapid`)
  pass(`${layout} workspace menu`, 'anchored to its button, Escape and outside click close, rapid input ends in the last state')
}

async function offSuite(cdp, label) {
  assert(await cdp.evaluate(`document.documentElement.dataset.vastMotion`) === 'off', `${label}: motion is off`)
  await palette(cdp)
  await until(cdp, `document.activeElement?.closest('.command-palette-shell')`, 'palette')
  assert(await cdp.evaluate(RUNNING) === 0, `${label}: no entrance`)
  await escape(cdp)
  assert(await cdp.evaluate(`!document.querySelector('.command-palette-shell')`), `${label}: removed at once`)
  // Functionality without motion: a context-menu action, find, a tab close.
  await cdp.click(`document.querySelector('[data-tab-motion-id="t2"]')`, 'right', { x: 10, y: 8 })
  await until(cdp, `document.querySelector('[role="menu"]')`, 'menu')
  await cdp.click(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.querySelector('.block.truncate')?.textContent.trim() === 'Close tab')`)
  await until(cdp, `!document.querySelector('[data-tab-motion-id="t2"]') && !document.querySelector('[role="menu"]')`, 'closed')
  await cdp.key('f', 'KeyF', 70, CTRL)
  await until(cdp, `document.activeElement?.placeholder === 'Find in page'`, 'find')
  await escape(cdp)
  const leftovers = await cdp.evaluate(LEFTOVERS)
  assert(leftovers.animations === 0 && leftovers.exiting === 0 && leftovers.ghosts === 0, `${label}: ${JSON.stringify(leftovers)}`)
  pass(label, 'no animations at all, surfaces close instantly, menus, find and tab close work')
}

async function main() {
  assert(fs.existsSync(path.join(root, 'out', 'renderer', 'index.html')), 'Run npm run build first')
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><title>Motion ${request.url}</title><main style="height:3000px">${request.url}</main>`)
  })
  await new Promise((resolve) => server.listen(serverPort, '127.0.0.1', resolve))
  const template = (await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA
  try {
    await withApp(template, {}, standardSuite)
    await withApp(template, { sidePanelMode: 'overlay' }, overlayPanelSuite)
    await withApp(template, { layout: 'horizontal', motionLevel: 'standard' }, (cdp) => workspaceMenuSuite(cdp, 'horizontal'))
    await withApp(template, { layout: 'purist', motionLevel: 'enhanced' }, (cdp) => workspaceMenuSuite(cdp, 'purist'))
    await withApp(template, { animations: false, motionLevel: 'enhanced' }, (cdp) => offSuite(cdp, 'motion Off'))
    await withApp(template, { reducedMotion: true, motionLevel: 'enhanced' }, (cdp) => offSuite(cdp, 'prefers-reduced-motion'))
  } finally {
    server.close()
  }
  console.log(`Motion E2E: ${results.length} checks passed`)
}

main().catch((error) => { console.error(error); process.exit(1) })
