import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createUpdaterStateMachine, redactUpdaterError } from '../../src/main/updater-state.ts'
import { updaterDisabledReason } from '../../src/shared/updater-policy.ts'
import { stagePendingUpdate, updateCacheKey, pendingUpdatePath, readPendingUpdate } from '../../src/main/updater-pending.ts'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../../src/main/updater.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

async function fixture(t: { after: (fn: () => unknown) => void }, options: { env?: Record<string,string>; packaged?: boolean; store?: boolean; installed?: boolean; profileInside?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vast-update-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'resources')
  const install = join(root, 'installation')
  const profile = join(options.profileInside ? install : root, 'profile with spaces')
  await mkdir(install)
  await mkdir(resources)
  await mkdir(profile)
  await writeFile(join(resources, 'apply-update.ps1'), '# isolated fixture')
  await writeFile(join(resources, 'app-update.yml'), `provider: github
owner: vstxx
repo: vast-public
updaterCacheDirName: vast-browser-updater
publisherName: VastProductions
`)
  if (options.installed !== false) await writeFile(join(install, 'Uninstall Vast.exe'), '')
  const app = Object.assign(new EventEmitter(), {
    isPackaged: options.packaged !== false,
    getPath: (name: string) => name === 'exe' ? join(install, 'Vast.exe') : profile,
    quits: 0,
    quit() { this.quits++ }
  })
  const events: any[] = []
  const timers: { callback: () => void; delay: number; cleared?: boolean; unref: () => void }[] = []
  const drivers: any[] = []
  class Driver extends EventEmitter {
    autoDownload = false
    autoInstallOnAppQuit = false
    installs = 0
    checks = 0
    check: () => Promise<unknown> = async () => { this.emit('update-not-available', {version:'0.2.7'}); return null }
    constructor() { super(); drivers.push(this) }
    async checkForUpdates() { this.checks++; this.emit('checking-for-update'); return this.check() }
    quitAndInstall() { this.installs++ }
    ready() {
      this.emit('update-downloaded', {version:'0.2.8', downloadedFile:join(root,'setup.exe'), files:[{url:'setup.exe',sha512:Buffer.alloc(64).toString('base64')}]})
      // Mirrors the native BaseUpdater hook: actual quit, not before-quit.
      if (this.autoInstallOnAppQuit) app.once('quit', () => { this.installs++ })
    }
  }
  const metadata = {channel:'stable',distributionChannel:options.store?'microsoft-store':'direct',updateEnabled:true}
  const exports: any = {}
  runInNewContext(compiled, {
    exports, URL, console: { warn() {} },
    process: { platform:'win32',resourcesPath:resources,env:options.env ?? {} },
    setTimeout: (callback: () => void,delay: number) => { const timer = {callback,delay,unref() {}}; timers.push(timer); return timer },
    clearTimeout: (timer: any) => { timer.cleared = true },
    require: (name: string) => {
      if (name === 'electron/main') return {app}
      if (name === 'electron-updater') return {NsisUpdater:Driver}
      if (name === './build-info') return {getBuildMetadata:()=>metadata}
      if (name === '../shared/build-metadata') return {envFlag:(env: any,key: string,fallback: boolean)=>env[key]===undefined?fallback:env[key]==='1'}
      if (name === '../shared/updater-policy') return {updaterDisabledReason}
      if (name === './updater-state') return {createUpdaterStateMachine,redactUpdaterError}
      if (name === './updater-pending') return {stagePendingUpdate,updateCacheKey,pendingUpdatePath}
      if (name === './windows/WindowRegistry') return {windowRegistry:{broadcast:(_channel: string,event: any)=>events.push(event)}}
      return require(name)
    }
  })
  await exports.setupAutoUpdater()
  return {root,install,profile,app,events,timers,driver:drivers[0],drivers,service:exports}
}

test('startup initializes once, downloads and stages for next start, and preserves trusted config', async t => {
  const f = await fixture(t)
  await f.service.setupAutoUpdater()
  assert.equal(f.drivers.length,1)
  assert.equal(f.timers[0].delay,8000)
  assert.equal(f.driver.autoDownload,true)
  assert.equal(f.driver.autoInstallOnAppQuit,false)
  assert.equal(f.service.getUpdaterDiagnostics().autoInstallOnNextStart,true)
  assert.equal(f.driver.autoRunAppAfterInstall,false)
  assert.equal(f.driver.disableWebInstaller,true)
  assert.equal(f.driver.allowDowngrade,false)
  assert.equal(f.driver.allowPrerelease,false)
  assert.equal(f.driver.installDirectory,f.install)
  const config = await readFile(f.driver.updateConfigPath,'utf8')
  assert.match(config,/publisherName: VastProductions/)
  assert.match(config,/repo: vast-public/)
  assert.match(config,/updaterCacheDirName: vast-update-[a-f0-9]{24}/)
  const other = await fixture(t)
  assert.notEqual(config,await readFile(other.driver.updateConfigPath,'utf8'))
})

test('download completion is awaited; repeated checks coalesce and a prepared update survives quit', async t => {
  const f = await fixture(t)
  let finish!: () => void
  f.driver.check = async () => {
    f.driver.emit('update-available',{version:'0.2.8'})
    return {downloadPromise:new Promise<void>(resolve=>{finish=resolve})}
  }
  const check = f.service.checkForUpdates()
  assert.equal(f.service.checkForUpdates(),check)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.events.find(e=>e.event==='update-available').autoDownload,true)
  await assert.rejects(f.service.applyUpdateNow(),/not ready/)
  f.driver.emit('download-progress',{percent:25.5})
  f.driver.emit('download-progress',{percent:25.9})
  assert.equal(f.events.filter(e=>e.event==='downloading').length,1)
  f.driver.ready()
  finish()
  await check
  assert.equal(f.service.getUpdaterDiagnostics().state,'ready')
  await f.service.checkForUpdates()
  assert.equal(f.driver.checks,1)
  await f.service.applyUpdateNow()
  assert.equal(f.app.quits,1)
  assert.equal(f.driver.installs,0,'before-quit/save/cancel barriers must run first')
  f.app.emit('quit',{},0)
  assert.equal(f.driver.installs,0,'Windows installation is owned by the next-start handoff')
  const pending = await readPendingUpdate(pendingUpdatePath(join(f.install,'Vast.exe'),f.profile)) as any
  assert.equal(pending.version,'0.2.8')
  assert.equal(pending.automatic,true)
})

test('download failure is observed and retried; later success clears error', async t => {
  const f = await fixture(t)
  f.driver.check = async () => ({downloadPromise:Promise.reject(Error('connection reset'))})
  await f.service.checkForUpdates()
  assert.equal(f.service.getUpdaterDiagnostics().state,'error')
  assert.equal(f.timers.at(-1)?.delay,60000)
  f.driver.check = async () => {f.driver.ready();return {downloadPromise:Promise.resolve([])}}
  await f.service.checkForUpdates()
  assert.equal(f.service.getUpdaterDiagnostics().state,'ready')
  assert.equal(f.service.getUpdaterDiagnostics().lastError,undefined)
})

test('up-to-date is not stuck checking; shutdown cancels future checks', async t => {
  const f = await fixture(t)
  await f.service.checkForUpdates()
  assert.equal(f.service.getUpdaterDiagnostics().state,'up-to-date')
  assert.equal(f.timers.at(-1)?.delay,4*60*60*1000)
  f.app.emit('quit',{},0)
  assert.equal(f.timers.at(-1)?.cleared,true)
  await f.service.checkForUpdates()
  assert.equal(f.driver.checks,1)
})

test('opt-out is reported honestly and explicit close arms the next start', async t => {
  const f = await fixture(t,{env:{VAST_UPDATE_AUTO_DOWNLOAD:'0',VAST_UPDATE_AUTO_INSTALL:'0'}})
  f.driver.emit('update-available',{version:'0.2.8'})
  assert.equal(f.events.at(-1).autoDownload,false)
  f.driver.ready()
  await f.service.applyUpdateNow()
  await f.service.applyUpdateNow()
  assert.equal(f.driver.installs,0)
  f.app.emit('quit',{},0)
  assert.equal(f.driver.installs,0)
  const pending = await readPendingUpdate(pendingUpdatePath(join(f.install,'Vast.exe'),f.profile)) as any
  assert.equal(pending.automatic,true)
})

for (const [name,options] of Object.entries({
  development:{packaged:false},store:{store:true},portable:{env:{PORTABLE_EXECUTABLE_DIR:'D:\\Portable'}},unpacked:{installed:false},profileInsideApplication:{profileInside:true}
})) test(name + ' never receives the installed-browser updater',async t=>{
  const f = await fixture(t,options)
  assert.equal(f.service.getUpdaterDiagnostics().enabled,false)
  assert.equal(f.drivers.length,0)
  assert.equal(f.timers.length,0)
  await assert.rejects(f.service.applyUpdateNow())
})
