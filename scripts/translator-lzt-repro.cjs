// Live-site crash investigation. Uses a new temporary Vast profile; never touches a real profile.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { launchApp, summarize, until, wait } = require('./translator-bench.cjs')

const reportPath = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : null
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-tfv-lzt-'))
const profileSource = process.argv.includes('--profile') ? path.resolve(process.argv[process.argv.indexOf('--profile') + 1]) : null
if (profileSource) fs.cpSync(profileSource, userDataDir, { recursive: true, force: true })
const snapshots = []
const report = { userDataDir, snapshots, events: [], site: null, translation: null, exit: null, intentionalStop: false, logs: [] }
let app
const emit = (event, data) => {
  report.events.push({ at: new Date().toISOString(), event, data })
  console.log(event, JSON.stringify(data))
}
const save = () => {
  report.logs = app?.logs ?? []
  const dumps = path.join(userDataDir, 'CrashDumps')
  report.dumps = fs.existsSync(dumps) ? fs.readdirSync(dumps, { recursive: true }).filter((name) => /\.dmp$/i.test(name)) : []
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
}
async function snapshot(label) {
  try {
    const metrics = await app.metrics()
    const status = summarize(metrics)
    const data = { label, status, processes: metrics }
    snapshots.push(data)
    emit('metrics', { label, status })
  } catch (error) { emit('metrics-error', String(error)) }
}

async function main() {
  app = await launchApp({ extension: true, userDataDir, captureLogs: true })
  app.child.on('exit', (code, signal) => { report.exit = { code, signal, intentional: report.intentionalStop }; emit('app-exit', report.exit); save() })
  await app.main.evaluate(`(() => { const { app } = process.mainModule.require('electron'); globalThis.__tfvCrashes = []; app.on('render-process-gone', (_event, contents, details) => globalThis.__tfvCrashes.push({ url: contents.getURL(), pid: contents.getOSProcessId(), details })); app.on('child-process-gone', (_event, details) => globalThis.__tfvCrashes.push({ child: details })); return true })()`)
  await snapshot('before-site')
  await app.navigate('https://lzt.market/')
  await wait(12_000)
  report.site = await app.guest(`({ url: location.href, lang: document.documentElement.lang, title: document.title, text: document.body?.innerText.slice(0, 600), elements: document.querySelectorAll('*').length })`).catch((error) => ({ error: String(error) }))
  emit('site', report.site)
  await snapshot('site-loaded')
  const source = /^ru\b/i.test(report.site.lang || '') || /[А-Яа-яЁё]/.test(report.site.text || '') ? 'ru' : 'en'
  const target = 'pl'
  const sw = await app.worker()
  const route = await sw.evaluate(`translatorDebug.engine({ type: 'engine:status' })`).catch((error) => ({ error: String(error) }))
  emit('engine-before', route)
  emit('download-start', { source, target })
  const downloaded = await sw.evaluate(`translatorDebug.engine({ type: 'engine:download', source: '${source}', target: '${target}' })`)
  emit('download-complete', downloaded)
  await snapshot('models-downloaded')
  const tab = await sw.evaluate('translatorDebug.tabInfo()')
  emit('tab', tab)
  await sw.evaluate(`translatorDebug.startPageTranslation(${tab.tabId}, '${source}', '${target}')`)
  for (let i = 0; i < 30 && app.child.exitCode === null; i += 1) {
    await wait(2000)
    if (i % 3 === 0) await snapshot(`translate-${i}`)
    if (i % 2 === 0) await app.guest(`scrollBy(0, Math.max(500, innerHeight)), true`).catch(() => undefined)
    const state = await sw.evaluate(`translatorDebug.pageCommand(${tab.tabId}, { type: 'page:state' })`).catch((error) => ({ error: String(error) }))
    if (i % 3 === 0) emit('state', state)
    if (state.status === 'error') break
  }
  report.translation = await sw.evaluate(`translatorDebug.pageCommand(${tab.tabId}, { type: 'page:state' })`).catch((error) => ({ error: String(error) }))
  emit('translation-final', report.translation)
  emit('engine-after', await sw.evaluate(`translatorDebug.engine({ type: 'engine:status' })`).catch((error) => ({ error: String(error) })))
  const selected = await app.guest(`(() => { const text = document.body.innerText; return text.slice(0, 90) })()`).catch(() => '')
  if (selected) emit('selection', await sw.evaluate(`translatorDebug.engine({ type: 'engine:translate', source: '${source}', target: '${target}', fragments: [${JSON.stringify(selected)}], priority: 'selection', tag: 'lzt-repro' })`).catch((error) => ({ error: String(error) })))
  emit('crashes', await app.main.evaluate('globalThis.__tfvCrashes'))
  await snapshot('after-translation')
  sw.close()
}

main().catch((error) => { emit('failure', { message: String(error), stack: error.stack }); process.exitCode = 1 }).finally(async () => {
  save()
  if (app && app.child.exitCode === null) { report.intentionalStop = true; await app.stop().catch(() => undefined) }
  save()
  console.log('PROFILE', userDataDir)
})
