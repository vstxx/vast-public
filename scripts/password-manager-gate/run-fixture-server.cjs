const fs = require('node:fs')
const path = require('node:path')
const { createFixtureServer } = require('./fixtures.cjs')
const { ensureTlsMaterial } = require('./tls.cjs')

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--credential-hashes', '--tls-root', '--ready-file', '--port'].includes(key) || value === undefined) {
      throw new Error(`Invalid fixture-server argument: ${key || '(missing)'}`)
    }
    result[key.slice(2)] = value
  }
  const port = Number(result.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Fixture port must be between 1024 and 65535.')
  for (const field of ['credential-hashes', 'tls-root', 'ready-file']) {
    if (!result[field]) throw new Error(`Missing --${field}.`)
  }
  return { ...result, port }
}

function readExpectedHashes(filePath) {
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  for (const field of ['usernameSha256', 'passwordSha256']) {
    if (typeof record[field] !== 'string' || !/^[a-f0-9]{64}$/.test(record[field])) {
      throw new Error(`Credential hash record has invalid ${field}.`)
    }
  }
  return Object.freeze({ username: record.usernameSha256, password: record.passwordSha256 })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tls = ensureTlsMaterial(path.resolve(args['tls-root']))
  const expectedHashes = readExpectedHashes(path.resolve(args['credential-hashes']))
  const server = await createFixtureServer({ tls, port: args.port, expectedHashes })
  const readyPath = path.resolve(args['ready-file'])
  fs.mkdirSync(path.dirname(readyPath), { recursive: true })
  fs.writeFileSync(readyPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, port: server.port, startedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' })

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await server.close()
    process.exitCode = 0
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
