// Measures model storage and process memory in two persistent Vast workspaces.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { Cdp, launchApp, summarize, until, wait } = require('./translator-bench.cjs')

const out = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : null
const report = { date: new Date().toISOString(), steps: {} }
const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<!doctype html><html lang="en"><body><h1>Weather report for the city</h1><p>Clouds are gathering over the coast this afternoon.</p></body></html>')
})
function cacheBytes(profile) {
  const partitions = path.join(profile, 'Partitions')
  const result = {}
  for (const name of fs.readdirSync(partitions)) {
    if (!name.startsWith('vast-workspace-')) continue
    const root = path.join(partitions, name, 'Service Worker', 'CacheStorage')
    let total = 0
    const walk = (directory) => {
      if (!fs.existsSync(directory)) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(file)
        else total += fs.statSync(file).size
      }
    }
    walk(root)
    result[name] = total
  }
  return result
}
async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const app = await launchApp({ extension: true })
  try {
    await app.navigate(url)
    await until(() => app.guest('Boolean(document.querySelector("h1"))'), 'workspace one page')
    const sw1Target = await until(async () => (await app.targets()).find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js')), 'first service worker')
    const sw1 = await Cdp.connect(sw1Target.webSocketDebuggerUrl)
    await sw1.evaluate(`chrome.storage.local.set({ settings: { targetLanguage: 'pl', idleSeconds: 120 } }).then(() => translatorDebug.applySettings())`)
    await sw1.evaluate(`translatorDebug.engine({ type: 'engine:download', source: 'en', target: 'pl' })`)
    await sw1.evaluate(`translatorDebug.engine({ type: 'engine:translate', source: 'en', target: 'pl', fragments: ['Weather report for the city.'], priority: 'selection', tag: 'workspace-measure' })`)
    report.steps.one = { memory: summarize(await app.metrics()), cacheBytes: cacheBytes(app.userDataDir), engine: await sw1.evaluate(`translatorDebug.engine({ type: 'engine:status' })`) }
    console.log('one', JSON.stringify(report.steps.one))

    await app.ui.evaluate(`document.querySelector('[aria-label^="Switch workspace"]').click()`)
    await app.ui.evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'New workspace').click()`)
    await until(() => app.ui.evaluate(`Boolean(document.querySelector('[role="dialog"] input'))`), 'workspace prompt')
    await app.ui.evaluate(`(() => { const input = document.querySelector('[role="dialog"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Translator Bench Two'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await app.ui.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent?.trim() === 'Create workspace').click()`)
    await until(() => app.ui.evaluate(`Boolean(document.querySelector('[aria-label="Switch workspace. Current: Translator Bench Two"]'))`), 'second workspace')
    await app.navigate(url)
    await until(() => app.guest('Boolean(document.querySelector("h1"))'), 'workspace two page')
    const toolbar = await app.ui.evaluate(`window.vast.extensions.contributions().then((reply) => reply.contributions.toolbar.find((entry) => entry.title === 'Translate'))`)
    await app.ui.evaluate(`window.vast.extensions.dispatchContribution(${JSON.stringify(toolbar.key)})`)
    const sw2Target = await until(async () => (await app.targets()).find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js') && target.id !== sw1Target.id), 'second service worker')
    const sw2 = await Cdp.connect(sw2Target.webSocketDebuggerUrl)
    const before = await sw2.evaluate(`translatorDebug.engine({ type: 'engine:route', source: 'en', target: 'pl' })`)
    await sw2.evaluate(`chrome.storage.local.set({ settings: { targetLanguage: 'pl', idleSeconds: 120 } }).then(() => translatorDebug.applySettings())`)
    await sw2.evaluate(`translatorDebug.engine({ type: 'engine:download', source: 'en', target: 'pl' })`)
    await sw2.evaluate(`translatorDebug.engine({ type: 'engine:translate', source: 'en', target: 'pl', fragments: ['Weather report for the city.'], priority: 'selection', tag: 'workspace-measure' })`)
    await wait(1000)
    report.steps.two = { beforeInstalled: before.installed, memory: summarize(await app.metrics()), cacheBytes: cacheBytes(app.userDataDir), engineOne: await sw1.evaluate(`translatorDebug.engine({ type: 'engine:status' })`), engineTwo: await sw2.evaluate(`translatorDebug.engine({ type: 'engine:status' })`) }
    console.log('two', JSON.stringify(report.steps.two))
    sw1.close(); sw2.close()
  } finally {
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2))
    await app.stop()
    server.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
