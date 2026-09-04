import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { redactAvidaeLogLine } from '../../src/main/avidae-log.ts'

const mainSource = readFileSync(new URL('../../src/main/avidae.ts', import.meta.url), 'utf8')
const authSource = readFileSync(new URL('../../src/main/avidae-auth.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
const avidaeIpcSource = readFileSync(new URL('../../src/main/ipc/avidae.ts', import.meta.url), 'utf8')
const startupSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const updaterSource = readFileSync(new URL('../../src/main/updater.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../resources/avidae/app.py', import.meta.url), 'utf8')
const securitySource = readFileSync(new URL('../../resources/avidae/security.py', import.meta.url), 'utf8')
const runtimeBuilderSource = readFileSync(new URL('../../scripts/prepare-avidae-runtime.cjs', import.meta.url), 'utf8')

test('Video & Audio HTTP, socket, path, and SSRF security tests pass', () => {
  const result = spawnSync('python', ['tests/avidae/avidae_security_test.py'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('Video & Audio receives an explicit environment allowlist and per-launch secret', () => {
  assert.match(mainSource, /inheritedEnvironmentKeys/)
  assert.doesNotMatch(mainSource, /\.\.\.process\.env/)
  assert.match(mainSource, /randomBytes\(32\)\.toString\('base64url'\)/)
  assert.match(mainSource, /AVIDAE_AUTH_TOKEN: launchToken/)
  assert.match(mainSource, /Bearer \$\{authToken\}/)
  assert.match(mainSource, /redactAvidaeLogLine\(line, authToken\)/)
  assert.match(authSource, /new URL\(rawUrl\)\.origin === authorizationOrigin/)
})

test('Video & Audio manager stays outside the critical startup bundle', () => {
  assert.doesNotMatch(startupSource, /from '\.\/avidae'/)
  assert.doesNotMatch(sessionsSource, /from '\.\/avidae'/)
  assert.doesNotMatch(updaterSource, /from '\.\/avidae'/)
  assert.doesNotMatch(ipcSource, /from '\.\/avidae'/)
  assert.match(ipcSource, /registerAvidaeIpc\(handle\)/)
  assert.match(startupSource, /import\('\.\/avidae'\).*stopAvidae/s)
  assert.match(updaterSource, /import\('\.\/avidae'\).*stopAvidae/s)
  for (const method of ['getAvidaeStatus', 'startAvidae', 'stopAvidae', 'installAvidaeDependencies']) {
    assert.match(avidaeIpcSource, new RegExp(`import.+avidae.+${method}`))
  }
  assert.match(sessionsSource, /from '\.\/avidae-auth'/)
})

test('Video & Audio runtime preparation preserves the tracked placeholder byte-for-byte', () => {
  assert.match(runtimeBuilderSource, /const preservedRuntimeReadme = existsSync\(runtimeReadmePath\)/)
  assert.match(runtimeBuilderSource, /writeFileSync\(runtimeReadmePath, preservedRuntimeReadme\)/)
})

test('Video & Audio process shutdown terminates descendants and uses bounded health checks', () => {
  assert.match(mainSource, /taskkill\.exe/)
  assert.match(mainSource, /'\/T', '\/F'/)
  assert.match(mainSource, /process\.kill\(-processRef\.pid, 'SIGKILL'\)/)
  assert.match(mainSource, /AbortSignal\.timeout\(1_500\)/)
  assert.match(mainSource, /if \(child\) \{\s*await stopChildProcess\(child\)/)
})

test('Video & Audio logs redact launch tokens, bearer values, and URL credentials', () => {
  const token = 'secret-launch-token'
  const output = redactAvidaeLogLine(`Bearer abc.def ${token} https://example.test/?token=private&code=oauth` , token)
  assert.doesNotMatch(output, /abc\.def|secret-launch-token|token=private|code=oauth/)
  assert.match(output, /Bearer \[redacted\]/)
})

test('Video & Audio API validates auth, Host, Origin, bodies, paths, and public DNS on redirects', () => {
  assert.match(appSource, /@app\.before_request/)
  assert.match(appSource, /hmac\.compare_digest/)
  assert.match(appSource, /Invalid Host/)
  assert.match(appSource, /Unsupported content type/)
  assert.match(appSource, /os\.path\.realpath/)
  assert.match(securitySource, /socket\.getaddrinfo/)
  assert.match(securitySource, /MAX_REDIRECTS/)
  assert.match(securitySource, /ip\.is_private/)
  assert.match(securitySource, /_PinnedHTTPSConnection/)
  assert.match(appSource, /_spreadsheet_safe/)
})
