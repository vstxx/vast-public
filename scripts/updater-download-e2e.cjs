// Run with Electron, not Node: exercises the real electron-updater HTTP/cache path.
const { app } = require('electron')
const { NsisUpdater } = require('electron-updater')
const { getAppCacheDir } = require('electron-updater/out/AppAdapter')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { createHash, randomUUID } = require('node:crypto')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

async function main() {
  await app.whenReady()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vast-download-e2e-'))
  const cacheName = 'vast-download-e2e-' + randomUUID()
  const cache = path.join(getAppCacheDir(), cacheName)
  const payload = Buffer.alloc(512 * 1024, 37)
  const digest = createHash('sha512').update(payload).digest('base64')
  let downloads = 0
  let corruptHash = false
  let interrupt = false
  const server = http.createServer((req,res) => {
    if (req.url.startsWith('/latest.yml')) {
      res.end(`version: 9999.0.0
files:
  - url: Vast-Setup-9999.0.0.exe
    sha512: ${corruptHash ? Buffer.alloc(64).toString('base64') : digest}
    size: ${payload.length}
path: Vast-Setup-9999.0.0.exe
sha512: ${digest}
`)
    } else {
      downloads++
      res.writeHead(200, {'Content-Length':payload.length})
      if (interrupt) { res.write(payload.subarray(0,128)); setTimeout(()=>res.destroy(),20) }
      else res.end(payload)
    }
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const config = path.join(root,'app-update.yml')
  await fs.writeFile(config,`provider: generic
url: http://127.0.0.1:${server.address().port}/
updaterCacheDirName: ${cacheName}
`)
  const make = () => {
    const driver = new NsisUpdater()
    driver.forceDevUpdateConfig = true
    driver.updateConfigPath = config
    driver.autoInstallOnAppQuit = false
    driver.disableDifferentialDownload = true
    driver.disableWebInstaller = true
    driver.logger = { info(){},warn(){},error(){},debug(){} }
    driver.quitAndInstall = () => { throw Error('Test must never launch an installer') }
    return driver
  }
  const download = async driver => {
    const result = await driver.checkForUpdates()
    assert(result?.downloadPromise)
    return result.downloadPromise
  }
  try {
    let progress = 0
    let ready = 0
    const first = make()
    first.on('download-progress',()=>progress++)
    first.on('update-downloaded',()=>ready++)
    const [file] = await download(first)
    assert.equal(ready,1)
    assert(progress > 0)
    assert.equal(downloads,1)
    assert.equal(createHash('sha512').update(await fs.readFile(file)).digest('base64'),digest)
    await download(make()) // new updater instance = another app launch
    assert.equal(downloads,1,'verified cache survives restart without downloading bytes again')
    await fs.writeFile(file,'truncated')
    await download(make())
    assert.equal(downloads,2,'corrupt cached executable is downloaded again')
    await fs.rm(cache,{recursive:true,force:true})
    interrupt = true
    await assert.rejects(download(make()))
    interrupt = false
    await download(make())
    assert.equal(downloads,4,'interrupted transfer never becomes ready and can retry')
    await fs.rm(cache,{recursive:true,force:true})
    corruptHash = true
    await assert.rejects(download(make()),/sha512|checksum/i)
    corruptHash = false
    await fs.appendFile(config,'publisherName: VastProductions\n')
    const rejected = make()
    rejected.verifyUpdateCodeSignature = async () => 'Untrusted fixture publisher'
    await assert.rejects(download(rejected),/not signed|publisher/i)
    console.log('PASS real Electron updater: download/progress, restart cache, corrupt cache, interrupted transfer/retry, SHA512 mismatch, publisher rejection; no installer executed')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve=>server.close(resolve))
    await fs.rm(root,{recursive:true,force:true})
    // Unique test cache only; never remove the app's real update cache.
    assert(path.basename(cache)===cacheName && cacheName.startsWith('vast-download-e2e-'))
    await fs.rm(cache,{recursive:true,force:true})
  }
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
