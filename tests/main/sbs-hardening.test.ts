import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

function filesUnder(path: string): string[] {
  const walk = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
    const file = join(directory, name)
    return statSync(file).isDirectory() ? walk(file) : [file]
  })
  return walk(fileURLToPath(new URL(path, root)))
}

test('every browser-owned renderer keeps the hardened Electron webPreferences baseline', () => {
  for (const path of ['src/main/window.ts', 'src/main/extensions/extension-native-runtime.ts']) {
    const source = read(path)
    assert.match(source, /sandbox:\s*true/, path)
    assert.match(source, /contextIsolation:\s*true/, path)
    assert.match(source, /nodeIntegration:\s*false/, path)
    assert.match(source, /webSecurity:\s*true/, path)
    assert.match(source, /allowRunningInsecureContent:\s*false/, path)
  }
})

test('production main code never disables sandbox, certificate, web security, or site isolation', () => {
  const source = filesUnder('src/main/').filter((path) => path.endsWith('.ts')).map((path) => readFileSync(path, 'utf8')).join('\n')
  for (const forbidden of ['--no-sandbox', '--disable-web-security', '--ignore-certificate-errors', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins', '--disable-features=site-per-process']) assert.equal(source.includes(forbidden), false, forbidden)
})

test('extension protocol does not bypass CSP and the documented file fuse exception is narrow', () => {
  const main = read('src/main/main.ts')
  const fuses = read('scripts/electron-fuses.cjs')
  assert.match(main, /registerSchemesAsPrivileged/)
  assert.doesNotMatch(main, /bypassCSP/)
  assert.match(fuses, /packaged renderer currently loads from app\.asar through file:\/\//)
  assert.match(fuses, /GrantFileProtocolExtraPrivileges:\s*true/)
  assert.match(fuses, /EnableCookieEncryption:\s*true/)
})

test('IPC handlers bind callers to a Vast window, main frame, and exact renderer URL', () => {
  const ipc = read('src/main/ipc.ts')
  assert.match(ipc, /vastWindowForWebContents\(event\.sender\)/)
  assert.match(ipc, /event\.senderFrame !== event\.sender\.mainFrame/)
  assert.match(ipc, /isTrustedRendererUrl\(event\.senderFrame\.url\)/)
  assert.match(ipc, /ipcMain\.handle\(channel, async \(event, \.\.\.args\) => \{\s*assertTrustedIpcSender\(event\)/)
})

test('release Actions are immutable and high-value credentials are step-scoped', () => {
  const workflowFiles = filesUnder('.github/').filter((path) => /\.(?:yml|yaml)$/.test(path))
  const externalAction = /uses:\s*(?!\.\/)([^\s@]+)@([^\s#]+)/g
  for (const path of workflowFiles) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(externalAction)) assert.match(match[2], /^[a-f0-9]{40}$/, `${path}: ${match[0]}`)
  }
  for (const path of ['.github/workflows/public-release.yml', '.github/workflows/public-unsigned-beta.yml']) {
    const jobEnv = read(path).match(/\n\s{4}env:\n([\s\S]*?)\n\s{4}steps:/)?.[1] ?? ''
    assert.doesNotMatch(jobEnv, /GH_TOKEN|WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD/, path)
  }
})

test('Hub and Relay production trust roots remain explicit and signer access stays private', () => {
  assert.match(read('src/main/extensions/trusted-hub-keys.ts'), /keyId: 'vast-hub-2026-02'[\s\S]*status: 'current'/)
  assert.match(read('extensions-hub/signer/wrangler.jsonc'), /"SIGNING_KEY_ID": "vast-hub-2026-02"/)
  const hub = read('extensions-hub/src/index.ts')
  assert.match(hub, /https:\/\/signer\.internal\/v1\/package/)
  assert.match(hub, /https:\/\/signer\.internal\/v1\/descriptor/)
  assert.doesNotMatch(hub, /path === ['"]\/v1\/(?:package|descriptor|proof)['"]/)
  for (const workflow of [read('.github/workflows/public-release.yml'), read('.github/workflows/public-unsigned-beta.yml')]) {
    assert.match(workflow, /VAST_RELAY_ENVIRONMENT:\s*production/)
    assert.match(workflow, /verify:release-checkin/)
    assert.match(workflow, /hub:verify:production/)
  }
})
