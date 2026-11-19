// Linux AppImage self-update check (CI, Linux only):
//   node scripts/linux-appimage-update-e2e.cjs --old <older.AppImage> --new <dir with newer AppImage + latest-linux.yml>
// The older build runs from its extracted AppDir with APPIMAGE pointing at an
// "installed" copy, and its app-update.yml redirected to a localhost feed that
// serves the newer release. After the update is downloaded, Vast is quit with
// SIGTERM (a normal quit); the installed file must then be the newer AppImage
// at the same path, the profile must be untouched, and the renderer must have
// run inside Chromium's namespace sandbox.
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); if (index < 0) throw new Error(`Missing ${name}`); return path.resolve(args[index + 1]) }
const oldAppImage = option('--old')
const newDir = option('--new')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha512 = (file) => createHash('sha512').update(fs.readFileSync(file)).digest('base64')

async function waitFor(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function descendants(pid) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, child, parent, command]) => ({ pid: Number(child), ppid: Number(parent), command }))
  const found = []
  const queue = [pid]
  while (queue.length) {
    const current = queue.shift()
    for (const row of rows) if (row.ppid === current) { found.push(row); queue.push(row.pid) }
  }
  return found
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Linux only')
  const feed = fs.readFileSync(path.join(newDir, 'latest-linux.yml'), 'utf8')
  const newName = feed.match(/^path:\s*(.+)$/m)?.[1].trim()
  if (!newName) throw new Error('latest-linux.yml has no path')
  const newAppImage = path.join(newDir, newName)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-appimage-update-'))
  const home = path.join(work, 'home')
  const installed = path.join(home, 'Applications', 'vast.AppImage')
  fs.mkdirSync(path.dirname(installed), { recursive: true })
  fs.copyFileSync(oldAppImage, installed)
  fs.chmodSync(installed, 0o755)
  const profileMarker = path.join(home, '.config', 'Vast', 'vast-update-e2e-profile.txt')
  fs.mkdirSync(path.dirname(profileMarker), { recursive: true })
  fs.writeFileSync(profileMarker, 'profile survives updates\n')

  execFileSync(installed, ['--appimage-extract'], { cwd: work, stdio: 'ignore' })
  const appDir = path.join(work, 'squashfs-root')

  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1))
    const file = path.join(newDir, path.basename(name))
    if (!name || !fs.existsSync(file)) { response.writeHead(404); response.end(); return }
    // Ranges let electron-updater use the embedded blockmap (differential download).
    const size = fs.statSync(file).size
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Number(range[2]) : size - 1
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
      fs.createReadStream(file, { start, end }).pipe(response)
    } else {
      response.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
      fs.createReadStream(file).pipe(response)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fs.writeFileSync(path.join(appDir, 'resources', 'app-update.yml'),
    `provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: vast-browser-updater\n`)

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    APPIMAGE: installed
  }
  delete env.ELECTRON_RUN_AS_NODE
  const log = fs.openSync(path.join(work, 'vast.log'), 'w')
  const app = spawn(path.join(appDir, 'AppRun'), [], { env, stdio: ['ignore', log, log] })
  const exited = new Promise((resolve) => app.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    const renderer = await waitFor('a renderer process', 60_000, () => descendants(app.pid).find((row) => row.command.includes('--type=renderer')))
    const mainCommand = fs.readFileSync(`/proc/${app.pid}/cmdline`, 'utf8')
    if (mainCommand.includes('--no-sandbox') || renderer.command.includes('--no-sandbox')) throw new Error('Vast started with --no-sandbox')
    if (fs.readlinkSync(`/proc/${renderer.pid}/ns/user`) === fs.readlinkSync(`/proc/${app.pid}/ns/user`)) throw new Error('The renderer is not in a sandbox user namespace')
    console.log('[appimage-update] renderer runs in the namespace sandbox')

    const pending = path.join(home, '.cache', 'vast-browser-updater', 'pending')
    await waitFor('the verified update download', 180_000, () => fs.existsSync(path.join(pending, 'update-info.json')))
    await sleep(2_000)
    console.log('[appimage-update] update downloaded; quitting Vast')
    app.kill('SIGTERM')
    const result = await Promise.race([exited, sleep(60_000).then(() => { throw new Error('Vast did not quit') })])
    if (result.code !== 0) throw new Error(`Vast exited with ${JSON.stringify(result)}`)
  } catch (error) {
    app.kill('SIGKILL')
    console.error(fs.readFileSync(path.join(work, 'vast.log'), 'utf8').slice(-6000))
    throw error
  } finally {
    server.close()
  }

  if (sha512(installed) !== sha512(newAppImage)) throw new Error('The installed AppImage was not replaced with the newer release')
  if ((fs.statSync(installed).mode & 0o100) === 0) throw new Error('The updated AppImage is not executable')
  if (fs.readdirSync(path.dirname(installed)).length !== 1) throw new Error('The update left extra files next to the AppImage')
  if (!fs.existsSync(profileMarker)) throw new Error('The profile was changed by the update')
  console.log('[appimage-update] installed file replaced in place; profile intact')

  // The updated AppImage itself must start (FUSE or extract-and-run).
  const smoke = spawn(installed, [], { env, stdio: 'ignore' })
  const smokeExit = new Promise((resolve) => smoke.once('exit', (code) => resolve(code)))
  const early = await Promise.race([smokeExit, sleep(15_000).then(() => null)])
  if (early !== null) throw new Error(`The updated AppImage exited early with ${early}`)
  smoke.kill('SIGTERM')
  const smokeCode = await Promise.race([smokeExit, sleep(30_000).then(() => 'timeout')])
  if (smokeCode !== 0) throw new Error(`The updated AppImage did not quit cleanly (${smokeCode})`)
  spawnSync('rm', ['-rf', work])
  console.log('PASS Linux AppImage update: sandboxed launch, detection, verified download, in-place install on quit, profile preserved, updated AppImage starts')
}

main().catch((error) => { console.error(error); process.exit(1) })
