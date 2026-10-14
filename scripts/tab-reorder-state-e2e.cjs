const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { connectRenderer, waitFor, stopRun } = require('./performance-suite.cjs')

const root = path.resolve(__dirname, '..')
const dist = process.env.VAST_PATCHED_ELECTRON_DIST
if (!dist) throw new Error('Set VAST_PATCHED_ELECTRON_DIST to the verified Electron distribution.')
const executable = path.join(path.resolve(dist), process.platform === 'win32' ? 'electron.exe' : 'electron')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-tab-reorder-'))
const requests = new Map()
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  requests.set(pathname, (requests.get(pathname) ?? 0) + 1)
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(`<!doctype html><title>${pathname}</title><input id="draft"><div style="height:3000px">${pathname}</div>`)
})
let child
let renderer

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const ids = ['reorder-one', 'reorder-two', 'reorder-three']
  const data = structuredClone((await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.settings.layoutMode = 'horizontal'
  data.settings.advanced.experimentalFeatures = true
  data.settings.hibernateInactiveTabs = process.env.VAST_TEST_HIBERNATE_TABS === '1'
  data.settings.openingAnimation = false
  data.onboarding.completed = true
  const workspace = data.workspaces[0]
  workspace.activeTabId = ids[0]
  data.activeWorkspaceId = workspace.id
  data.tabs = ids.map((id, index) => ({
    id, workspaceId: workspace.id, title: id, url: `${origin}/${id}`,
    pinned: false, status: 'idle', lifecycle: index === 0 ? 'active' : 'sleeping',
    progress: 0, canGoBack: false, canGoForward: false, zoom: 1,
    createdAt: Date.now(), lastAccessedAt: Date.now()
  }))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))

  const port = 12000 + Math.floor(Math.random() * 1000)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0', VAST_RELAY_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`, root], { cwd: root, env, stdio: 'ignore', windowsHide: true })
  renderer = await connectRenderer(port)
  await waitFor(renderer, `document.querySelectorAll('.horizontal-chrome [data-tab-motion-id]').length === 3`, 20000)
  for (const id of [ids[1], ids[2], ids[0]]) {
    await renderer.evaluate(`document.querySelector('[data-tab-motion-id=${JSON.stringify(id)}]').click()`)
    await waitFor(renderer, `[...document.querySelectorAll('webview.browser-webview')].some((view) => view.getURL().endsWith('/${id}'))`, 10000)
  }
  await waitFor(renderer, `(() => {
    const views = [...document.querySelectorAll('webview.browser-webview')];
    return views.length === 3 && views.every((view) => view.getURL().startsWith(${JSON.stringify(origin)}));
  })()`, 15000).catch(async (error) => {
    const diagnostic = await renderer.evaluate(`({ tabs: [...document.querySelectorAll('[data-tab-motion-id]')].map((item) => item.dataset.tabMotionId), views: [...document.querySelectorAll('webview.browser-webview')].map((view) => ({ src: view.getAttribute('src'), url: (() => { try { return view.getURL() } catch (error) { return String(error) } })() })), text: document.body.innerText.slice(0, 1000) })`)
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`)
  })

  const before = await renderer.evaluate(`(async () => {
    window.__reorderViews = Object.fromEntries([...document.querySelectorAll('webview.browser-webview')].map((view) => [new URL(view.getURL()).pathname.slice(1), view]));
    return Promise.all(${JSON.stringify(ids)}.map(async (id) => {
      const view = window.__reorderViews[id];
      const page = await view.executeJavaScript('window.__reorderMarker = ' + JSON.stringify(id) + '; document.querySelector("#draft").value = ' + JSON.stringify(id + '-draft') + '; ({marker:window.__reorderMarker, draft:document.querySelector("#draft").value})');
      return { id, webContentsId: view.getWebContentsId(), page };
    }));
  })()`)
  assert.equal(before.length, 3)
  const originalLoads = Object.fromEntries(ids.map((id) => [id, requests.get(`/${id}`)]))

  await renderer.evaluate(`(() => {
    const source = document.querySelector('[data-tab-motion-id="reorder-one"]');
    const target = document.querySelector('[data-tab-motion-id="reorder-three"]');
    if (!source || !target) throw new Error('Tab controls missing');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'reorder-one');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  })()`)
  await waitFor(renderer, `[...document.querySelectorAll('.horizontal-chrome [data-tab-motion-id]')].map((tab) => tab.dataset.tabMotionId).join(',') === 'reorder-two,reorder-three,reorder-one'`, 10000)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const after = await renderer.evaluate(`(async () => Promise.all(${JSON.stringify(ids)}.map(async (id) => {
    const view = window.__reorderViews[id];
    const current = [...document.querySelectorAll('webview.browser-webview')].find((item) => item.getURL().endsWith('/' + id));
    let page;
    try { page = await current.executeJavaScript('({marker:window.__reorderMarker, draft:document.querySelector("#draft")?.value})'); }
    catch (error) { page = { error: String(error) }; }
    return { id, connected: view.isConnected, sameElement: view === current, webContentsId: current.getWebContentsId(), page };
  })))()`)
  console.log(JSON.stringify({ before, after, originalLoads, finalLoads: Object.fromEntries(ids.map((id) => [id, requests.get(`/${id}`)])) }, null, 2))
  for (const item of after) {
    const prior = before.find((entry) => entry.id === item.id)
    assert.equal(item.connected, true, `${item.id} webview detached`)
    assert.equal(item.sameElement, true, `${item.id} webview element replaced`)
    assert.equal(item.webContentsId, prior.webContentsId, `${item.id} guest process replaced`)
    assert.deepEqual(item.page, prior.page, `${item.id} page state changed`)
    assert.equal(requests.get(`/${item.id}`), originalLoads[item.id], `${item.id} unexpectedly reloaded`)
  }
  console.log('PASS horizontal reorder preserves all guest processes and page state.')

  async function selectLayout(layout) {
    for (const type of ['keyDown', 'keyUp']) {
      await renderer.send('Input.dispatchKeyEvent', { type, code: 'KeyK', key: 'k', windowsVirtualKeyCode: 75, modifiers: 2 })
    }
    await waitFor(renderer, `document.querySelector('.command-palette-panel')`, 10000)
    await renderer.evaluate(`(() => {
      const button = [...document.querySelectorAll('.command-palette-item')].find((item) => item.textContent.includes('Open settings'));
      if (!button) throw new Error('Open settings command missing');
      button.click();
    })()`)
    await waitFor(renderer, `document.querySelector('.settings-modal-shell')`, 10000)
    await renderer.evaluate(`document.querySelector('[role="group"][aria-label="Layout"] button[aria-label=${JSON.stringify(layout)}]').click()`)
    await renderer.evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`)
    await waitFor(renderer, `document.querySelector('.app-shell.layout-${layout.toLowerCase()}') && !document.querySelector('.settings-modal-shell')`, 10000)
  }

  async function reorderAgain(layout, from, to, expectedOrder) {
    const selector = layout === 'Vertical' ? 'aside [data-tab-motion-id]'
      : layout === 'Purist' ? '.purist-tab-bar [data-tab-motion-id]'
        : '.horizontal-chrome [data-tab-motion-id]'
    const dragResult = await renderer.evaluate(`(() => {
      const source = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.dataset.tabMotionId === ${JSON.stringify(from)});
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.dataset.tabMotionId === ${JSON.stringify(to)});
      if (!source || !target) throw new Error('Tab controls missing for ${layout}');
      const rect = target.getBoundingClientRect();
      const sourceAside = source.closest('aside')?.getBoundingClientRect();
      const coords = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer, ...coords }));
      const transfer = dataTransfer.getData('text/plain');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...coords }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...coords }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer, ...coords }));
      return { transfer, coords, targetRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, sourceAside: sourceAside && { left: sourceAside.left, top: sourceAside.top, right: sourceAside.right, bottom: sourceAside.bottom }, order: [...document.querySelectorAll(${JSON.stringify(selector)})].map((tab) => tab.dataset.tabMotionId) };
    })()`)
    console.log(`${layout} drag: ${JSON.stringify(dragResult)}`)
    await waitFor(renderer, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((tab) => tab.dataset.tabMotionId).join(',') === ${JSON.stringify(expectedOrder.join(','))}`, 3000).catch(async (error) => {
      const diagnostic = await renderer.evaluate(`({ order: [...document.querySelectorAll(${JSON.stringify(selector)})].map((tab) => tab.dataset.tabMotionId), shell: document.querySelector('.app-shell')?.className, text: document.body.innerText.slice(0, 500) })`)
      throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`)
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const state = await renderer.evaluate(`(async () => Promise.all(${JSON.stringify(ids)}.map(async (id) => {
      const view = window.__reorderViews[id];
      const page = await view.executeJavaScript('({marker:window.__reorderMarker, draft:document.querySelector("#draft")?.value})');
      return { id, connected: view.isConnected, webContentsId: view.getWebContentsId(), page };
    })))()`)
    for (const item of state) {
      const prior = before.find((entry) => entry.id === item.id)
      assert.equal(item.connected, true, `${layout}: ${item.id} webview detached`)
      assert.equal(item.webContentsId, prior.webContentsId, `${layout}: ${item.id} guest process replaced`)
      assert.deepEqual(item.page, prior.page, `${layout}: ${item.id} page state changed`)
      assert.equal(requests.get(`/${item.id}`), originalLoads[item.id], `${layout}: ${item.id} unexpectedly reloaded`)
    }
    console.log(`PASS ${layout} reorder preserves all guest processes and page state.`)
  }

  await selectLayout('Vertical')
  await reorderAgain('Vertical', 'reorder-three', 'reorder-two', ['reorder-three', 'reorder-two', 'reorder-one'])
  await selectLayout('Purist')
  await waitFor(renderer, `document.querySelector('.topbar-island-compact')`, 10000)
  await renderer.evaluate(`document.querySelector('.topbar-island-compact').click()`)
  await waitFor(renderer, `document.querySelector('.topbar-island.is-expanded .purist-tab-bar [data-tab-motion-id]')`, 10000)
  await reorderAgain('Purist', 'reorder-one', 'reorder-three', ['reorder-one', 'reorder-three', 'reorder-two'])
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (renderer && child) await stopRun(child, renderer)
  await new Promise((resolve) => server.close(resolve))
  console.log(`Isolated profile: ${profile}`)
})
