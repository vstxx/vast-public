const { app, session } = require('electron')

const [mode, userData] = process.argv.slice(2)
if (!['seed', 'verify'].includes(mode) || !userData) throw new Error('Usage: electron cookie-encryption-fixture.cjs <seed|verify> <userData>')
app.setPath('userData', userData)

app.whenReady().then(async () => {
  const cases = [
    { id: 'default', value: 'default-secret', valueSession: session.defaultSession },
    { id: 'workspace', value: 'workspace-secret', valueSession: session.fromPartition('persist:vast-cookie-upgrade-workspace') },
    { id: 'isolated', value: 'isolated-secret', valueSession: session.fromPartition('persist:vast-cookie-upgrade-isolated') }
  ]
  for (const item of cases) {
    const url = `https://${item.id}.cookie-upgrade.vast.test/`
    const name = `vast_cookie_upgrade_${item.id}`
    if (mode === 'seed') {
      await item.valueSession.cookies.set({ url, name, value: item.value, expirationDate: Date.now() / 1000 + 3600 })
      await item.valueSession.cookies.flushStore()
    }
    const cookies = await item.valueSession.cookies.get({ url })
    const cookie = cookies.find((candidate) => candidate.name === name)
    if (cookie?.value !== item.value) throw new Error(`${item.id} cookie did not survive the cookie-encryption upgrade.`)
    if (mode === 'verify') {
      await item.valueSession.cookies.set({ url, name, value: item.value, expirationDate: Date.now() / 1000 + 7200 })
      await item.valueSession.cookies.flushStore()
    }
  }
  console.log(JSON.stringify({ ok: true, mode, sessions: cases.map((item) => item.id) }))
  app.exit(0)
}).catch((error) => { console.error(error); app.exit(1) })
