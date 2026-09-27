const { createHash } = require('node:crypto')
const https = require('node:https')
const { FIXTURE_HOSTS } = require('./config.cjs')
const { isApprovedFixtureHost } = require('./tls.cjs')

const MAX_SUBMISSION_BYTES = 64 * 1024

function fixtureUrl(host, routePath, port) {
  if (!isApprovedFixtureHost(host)) throw new Error(`Not an approved fixture host: ${host}`)
  if (typeof routePath !== 'string' || !routePath.startsWith('/') || routePath.startsWith('//')) {
    throw new Error('Fixture URL requires an absolute path beginning with one slash.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid fixture port: ${port}`)
  return `https://${host}:${port}${routePath}`
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

function loginForm() {
  return `<form id="gate-login" method="post" action="/__gate/submit">
  <label for="gate-username">Username</label>
  <input id="gate-username" name="username" autocomplete="username" />
  <label for="gate-password">Password</label>
  <input id="gate-password" name="password" type="password" autocomplete="current-password" />
  <button id="gate-submit" type="submit">Sign in</button>
</form>`
}

function nativeLoginForm() {
  return `<form id="gate-native-login" method="post" action="/__gate/native-login-complete">
  <label for="gate-username">Username</label>
  <input id="gate-username" name="username" autocomplete="username" />
  <label for="gate-password">Password</label>
  <input id="gate-password" name="password" type="password" autocomplete="current-password" />
  <button id="gate-submit" type="submit">Sign in</button>
</form>`
}

function signupForm() {
  return `<form id="gate-signup" method="post" action="/__gate/signup-complete">
  <label for="gate-username">Username</label>
  <input id="gate-username" name="username" autocomplete="username" />
  <label for="gate-password">Password</label>
  <input id="gate-password" name="password" type="password" autocomplete="new-password" />
  <button id="gate-submit" type="submit">Create account</button>
</form>`
}

function passwordChangeForm() {
  return `<form id="gate-password-change" method="post" action="/__gate/password-change-complete">
  <label for="gate-username">Username</label>
  <input id="gate-username" name="username" autocomplete="username" />
  <label for="gate-current-password">Current password</label>
  <input id="gate-current-password" name="currentPassword" type="password" autocomplete="current-password" />
  <label for="gate-password">New password</label>
  <input id="gate-password" name="newPassword" type="password" autocomplete="new-password" />
  <label for="gate-confirm-password">Confirm new password</label>
  <input id="gate-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" />
  <button id="gate-submit" type="submit">Change password</button>
</form>`
}

function browserGateScript(fixture, expectedHashes, extraScript = '') {
  const configuration = safeJson({ fixture, expectedHashes })
  return `<script>
(() => {
  'use strict'
  const configuration = ${configuration}
  const submission = { submitted: false, matched: false }
  async function digest(value) {
    const bytes = new TextEncoder().encode(value)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  async function snapshot() {
    const username = document.getElementById('gate-username')
    const password = document.getElementById('gate-password')
    const usernamePresent = Boolean(username && username.value)
    const passwordPresent = Boolean(password && password.value)
    const usernameMatchesExpectedHash = usernamePresent && await digest(username.value) === configuration.expectedHashes.username
    const passwordMatchesExpectedHash = passwordPresent && await digest(password.value) === configuration.expectedHashes.password
    return {
      fixture: configuration.fixture,
      route: location.pathname,
      frameOrigin: location.origin,
      usernamePresent,
      passwordPresent,
      usernameMatchesExpectedHash,
      passwordMatchesExpectedHash,
      unexpectedForeignFill: (usernamePresent && !usernameMatchesExpectedHash) || (passwordPresent && !passwordMatchesExpectedHash),
      submitted: submission.submitted,
      submissionMatchedExpectedHashes: submission.matched
    }
  }
  document.addEventListener('submit', async (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'gate-login') return
    event.preventDefault()
    const username = document.getElementById('gate-username')
    const password = document.getElementById('gate-password')
    const response = await fetch('/__gate/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ username: username?.value || '', password: password?.value || '' })
    })
    const result = await response.json()
    submission.submitted = true
    submission.matched = result.usernameMatchesExpectedHash === true && result.passwordMatchesExpectedHash === true
  })
  window.__vastGate = Object.freeze({ snapshot })
  ${extraScript}
})()
</script>`
}

function htmlPage(fixture, expectedHashes, content, extraScript = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Vast gate: ${fixture}</title>
</head>
<body data-vast-gate-fixture="${fixture}">
  <main id="gate-root">${content}</main>
  ${browserGateScript(fixture, expectedHashes, extraScript)}
</body>
</html>`
}

function response(status, body, fixture, contentType = 'text/html; charset=utf-8') {
  return {
    status,
    fixture,
    headers: {
      'cache-control': 'no-store',
      'content-type': contentType,
      'x-content-type-options': 'nosniff'
    },
    body
  }
}

function iframePage(fixture, expectedHashes, source) {
  return htmlPage(fixture, expectedHashes, `<iframe id="gate-frame" title="${fixture}" src="${source}"></iframe>`)
}

function normalizeRequestPath(value) {
  try {
    return new URL(value, 'https://fixture.invalid').pathname
  } catch {
    return '/'
  }
}

function fixtureQuery(value, fallback) {
  try {
    return new URL(value, 'https://fixture.invalid').searchParams.get('fixture') || fallback
  } catch {
    return fallback
  }
}

function routeFixtureRequest(request, expectedHashes, port) {
  const host = String(request.host || '').trim().toLowerCase().replace(/:\d+$/, '')
  const method = String(request.method || 'GET').toUpperCase()
  const routePath = normalizeRequestPath(request.path)
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body || '')

  if (!isApprovedFixtureHost(host)) return response(421, 'Misdirected Request', 'rejected-host', 'text/plain; charset=utf-8')
  if (method === 'POST' && (routePath === '/__gate/signup-complete' ||
      routePath === '/__gate/password-change-complete')) {
    if (body.length > MAX_SUBMISSION_BYTES) {
      return response(413, 'Submission too large', 'submission-too-large', 'text/plain; charset=utf-8')
    }
    return response(200, htmlPage(routePath.includes('signup') ? 'signup-complete' : 'password-change-complete',
      expectedHashes, '<h1 id="gate-complete">Success</h1>'),
    routePath.includes('signup') ? 'signup-complete' : 'password-change-complete')
  }
  if (method === 'POST' && routePath === '/__gate/native-login-complete') {
    if (body.length > MAX_SUBMISSION_BYTES) {
      return response(413, 'Submission too large', 'submission-too-large', 'text/plain; charset=utf-8')
    }
    const values = new URLSearchParams(body.toString('utf8'))
    const matched = sha256(values.get('username') || '') === expectedHashes.username &&
      sha256(values.get('password') || '') === expectedHashes.password
    return response(200, htmlPage('native-login-complete', expectedHashes,
      '<h1 id="gate-complete">Success</h1>',
      `submission.submitted = true; submission.matched = ${matched}`),
    'native-login-complete')
  }
  if (method === 'POST' && routePath === '/__gate/submit') {
    if (body.length > MAX_SUBMISSION_BYTES) {
      return response(413, JSON.stringify({ accepted: false, tooLarge: true }), 'submission', 'application/json; charset=utf-8')
    }
    const values = new URLSearchParams(body.toString('utf8'))
    const username = values.get('username') || ''
    const password = values.get('password') || ''
    const result = {
      accepted: true,
      usernameMatchesExpectedHash: sha256(username) === expectedHashes.username,
      passwordMatchesExpectedHash: sha256(password) === expectedHashes.password
    }
    return response(200, JSON.stringify(result), 'submission', 'application/json; charset=utf-8')
  }
  if (method !== 'GET' && method !== 'HEAD') return response(405, 'Method Not Allowed', 'rejected-method', 'text/plain; charset=utf-8')

  if (host === 'login.vast-test.local' && routePath === '/login') {
    return response(200, htmlPage('ordinary-login', expectedHashes, loginForm()), 'ordinary-login')
  }
  if (host === 'login.vast-test.local' && routePath === '/native-login') {
    return response(200, htmlPage('native-login', expectedHashes, nativeLoginForm()), 'native-login')
  }
  if (host === 'login.vast-test.local' && routePath === '/signup') {
    return response(200, htmlPage('credential-signup', expectedHashes, signupForm()), 'credential-signup')
  }
  if (host === 'login.vast-test.local' && routePath === '/change-password') {
    return response(200, htmlPage('credential-update', expectedHashes, passwordChangeForm()), 'credential-update')
  }
  if (host === 'spa.vast-test.local' && (routePath === '/spa' || routePath === '/spa/route-two')) {
    const script = `
      const gateRoot = document.getElementById('gate-root')
      const render = () => { gateRoot.innerHTML = ${safeJson(loginForm())} }
      history.replaceState({ gate: true }, '', location.pathname)
      window.__vastGate = Object.freeze({ ...window.__vastGate, navigate(path = '/spa/route-two') { history.pushState({ gate: true }, '', path); render() } })
      addEventListener('popstate', render)
    `
    return response(200, htmlPage('spa-login', expectedHashes, loginForm(), script), 'spa-login')
  }
  if (host === 'dynamic.vast-test.local' && routePath === '/dynamic') {
    const script = `queueMicrotask(() => { document.getElementById('gate-root').innerHTML = ${safeJson(loginForm())} })`
    return response(200, htmlPage('dynamic-login', expectedHashes, '', script), 'dynamic-login')
  }
  if (host === 'dynamic.vast-test.local' && routePath === '/delayed') {
    const script = `setTimeout(() => { document.getElementById('gate-root').innerHTML = ${safeJson(loginForm())} }, 1200)`
    return response(200, htmlPage('delayed-login', expectedHashes, '', script), 'delayed-login')
  }
  if ((host === 'iframe.vast-test.local' || host === 'login.vast-test.local') && routePath === '/frame-login') {
    const fixture = fixtureQuery(request.path, 'iframe-login')
    return response(200, htmlPage(fixture, expectedHashes, loginForm()), fixture)
  }
  if (host === 'login.vast-test.local' && routePath === '/same-origin-iframe') {
    return response(200, iframePage('same-origin-iframe', expectedHashes, fixtureUrl('login.vast-test.local', '/frame-login?fixture=same-origin-frame', port)), 'same-origin-iframe')
  }
  if (host === 'login.vast-test.local' && routePath === '/cross-origin-iframe') {
    return response(200, iframePage('cross-origin-iframe', expectedHashes, fixtureUrl('iframe.vast-test.local', '/frame-login?fixture=cross-origin-frame', port)), 'cross-origin-iframe')
  }
  if (host === 'iframe.vast-test.local' && routePath === '/nested') {
    return response(200, iframePage('nested-frame', expectedHashes, fixtureUrl('iframe.vast-test.local', '/nested-middle', port)), 'nested-frame')
  }
  if (host === 'iframe.vast-test.local' && routePath === '/nested-middle') {
    return response(200, iframePage('nested-middle', expectedHashes, fixtureUrl('login.vast-test.local', '/frame-login?fixture=nested-inner', port)), 'nested-middle')
  }
  if (host === 'login.vast-test.local' && routePath === '/dynamic-iframe') {
    const child = fixtureUrl('iframe.vast-test.local', '/frame-login?fixture=dynamic-frame', port)
    const script = `setTimeout(() => { const frame = document.createElement('iframe'); frame.id = 'gate-dynamic-frame'; frame.title = 'dynamic-frame'; frame.src = ${safeJson(child)}; document.getElementById('gate-root').append(frame) }, 500)`
    return response(200, htmlPage('dynamic-iframe', expectedHashes, '', script), 'dynamic-iframe')
  }
  return response(404, 'Not Found', 'not-found', 'text/plain; charset=utf-8')
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      length += chunk.length
      if (length > MAX_SUBMISSION_BYTES) {
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) {
        chunks.push(chunk)
      }
    })
    request.on('end', () => resolve(tooLarge ? Buffer.alloc(MAX_SUBMISSION_BYTES + 1) : Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function createFixtureServer({ tls, port = 0, expectedHashes }) {
  const server = https.createServer({ pfx: tls.pfx, passphrase: tls.passphrase })
  server.on('request', async (request, serverResponse) => {
    try {
      const body = await collectBody(request)
      const routed = routeFixtureRequest({
        host: request.headers.host,
        method: request.method,
        path: request.url,
        body
      }, expectedHashes, server.address().port)
      serverResponse.writeHead(routed.status, routed.headers)
      serverResponse.end(request.method === 'HEAD' ? undefined : routed.body)
    } catch {
      serverResponse.writeHead(500, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      serverResponse.end('Fixture server error')
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', onError)
      resolve()
    })
  })
  const actualPort = server.address().port
  const origins = Object.fromEntries(FIXTURE_HOSTS.map((host) => [host, fixtureUrl(host, '/', actualPort).replace(/\/$/, '')]))
  return Object.freeze({
    port: actualPort,
    origins: Object.freeze(origins),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
}

module.exports = {
  MAX_SUBMISSION_BYTES,
  createFixtureServer,
  fixtureUrl,
  routeFixtureRequest
}
