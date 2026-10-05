#!/usr/bin/env node
// Measures host UI response in a packaged Vast with a disposable local profile.
// DOM insertion and two rAF callbacks are proxies; neither is GPU presentation.
const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { seedBenchmarkProfile } = require('./guest-scroll-profile.cjs')

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const separator = value.indexOf('=')
  return [value.slice(2, separator), value.slice(separator + 1)]
}))
if (!args.executable || !args.output) throw new Error('Usage: node scripts/host-interaction-benchmark.cjs --executable=<packaged Vast.exe> --output=<directory>')
const executable = path.resolve(args.executable)
const output = path.resolve(args.output)
if (!fs.statSync(executable).isFile()) throw new Error('Executable not found')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Cdp(socket)
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }
  close() { this.socket.close() }
}

async function target(port, predicate) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json()).catch(() => [])
    const found = list.find(predicate)
    if (found) return found
    await wait(100)
  }
  throw new Error('Host CDP target not found')
}
async function waitFor(cdp, expression) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    if (await cdp.evaluate(`Boolean(${expression})`).catch(() => false)) return
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

async function measure(cdp, action, selector) {
  const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]))
  const timing = await cdp.evaluate(`new Promise((resolve,reject)=>{
    const action=${action}; const selector=${JSON.stringify(selector)};
    const before=performance.now(); const tasks=[];
    const longTasks=new PerformanceObserver(list=>tasks.push(...list.getEntries().filter(entry=>entry.startTime>=before).map(entry=>entry.duration)));
    longTasks.observe({type:'longtask',buffered:true});
    const timer=setTimeout(()=>{observer.disconnect();longTasks.disconnect();reject(new Error('UI element did not appear: '+selector))},10000);
    const observer=new MutationObserver(()=>{
      const element=document.querySelector(selector);
      if(!element)return;
      observer.disconnect();clearTimeout(timer);
      const domMs=performance.now()-before;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        longTasks.disconnect();
        resolve({domMs,twoRafMs:performance.now()-before,longTaskCount:tasks.length,longTaskTotalMs:tasks.reduce((a,b)=>a+b,0)});
      }));
    });
    observer.observe(document.body,{subtree:true,childList:true,attributes:true});
    try{action()}catch(error){clearTimeout(timer);observer.disconnect();longTasks.disconnect();reject(error)}
  })`)
  const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]))
  const fields = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']
  return { ...timing, rendererMetrics: Object.fromEntries(fields.map((field) => [field, (after[field] ?? 0) - (before[field] ?? 0)])) }
}

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end('<!doctype html><title>Vast host UI benchmark</title><main>Local, unauthenticated fixture</main>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const constants = await import(pathToFileURL(path.join(__dirname, '../src/shared/constants.ts')).href)
  const profile = fs.mkdtempSync(path.join(output, 'profile-'))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(seedBenchmarkProfile(constants.DEFAULT_DATA, url)))
  const debugPort = 10000 + Math.floor(Math.random() * 30000)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], { env, windowsHide: true, stdio: 'ignore' })
  let host
  try {
    const entry = await target(debugPort, (item) => item.type === 'page' && item.url.includes('index.html'))
    host = await Cdp.connect(entry.webSocketDebuggerUrl)
    await host.send('Runtime.enable')
    await host.send('Performance.enable')
    await host.evaluate('window.resizeTo(1280,800)')
    await host.send('Page.bringToFront')
    await waitFor(host, `document.querySelector('webview')?.getURL().startsWith(${JSON.stringify(url)}) && !document.querySelector('webview').isLoading()`)
    await wait(1200)
    const results = []
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      console.log(`settings ${repetition}/3`)
      await host.evaluate(`document.querySelector('button[title="More browser tools"]').click()`)
      await waitFor(host, `Boolean([...document.querySelectorAll('.browser-tools-menu button')].find(button=>button.textContent.trim()==='Settings'))`)
      const settings = await measure(host, `()=>[...document.querySelectorAll('.browser-tools-menu button')].find(button=>button.textContent.trim()==='Settings').click()`, '.settings-modal-shell')
      results.push({ action: 'settings-open', repetition, ...settings })
      await host.evaluate(`document.querySelector('button[title="Close settings"]').click()`)
      await waitFor(host, `!document.querySelector('.settings-modal-shell')`)
      console.log(`side panel ${repetition}/3`)
      const sidePanel = await measure(host, `()=>document.querySelector('button[title="Show sidebar"]').click()`, '.side-panel-slot.is-open .side-panel')
      results.push({ action: 'side-panel-open', repetition, ...sidePanel })
      await host.evaluate(`document.querySelector('button[title="Hide sidebar"]').click()`)
      await waitFor(host, `!document.querySelector('.side-panel-slot.is-open')`)
      await wait(500)
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ schemaVersion: 1, executable, url, viewport: { width: 1280, height: 800 }, results, note: 'DOM insertion and two requestAnimationFrame callbacks in host renderer; not GPU presentation' }, null, 2))
    console.log(results)
  } finally {
    await host?.evaluate('window.vast.app.window.close()').catch(() => undefined)
    await wait(1000)
    if (child.exitCode === null) try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    host?.close(); server.close()
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
