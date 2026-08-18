import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const defaultBrowserSource = readFileSync(new URL('../../src/main/default-browser.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  build?: { protocols?: Array<{ name?: string; schemes?: string[] }> }
}

test('windows default browser registration advertises Vast for HTTP and HTTPS', () => {
  assert.match(defaultBrowserSource, /HKCU\\\\Software\\\\RegisteredApplications/)
  assert.match(defaultBrowserSource, /StartMenuInternet\\\\Vast/)
  assert.match(defaultBrowserSource, /Capabilities\\\\URLAssociations/)
  assert.match(defaultBrowserSource, /VastHTML/)
  assert.match(defaultBrowserSource, /shell\\\\open\\\\command/)
})

test('default browser setup opens the focused Windows Default Apps settings page', () => {
  assert.match(defaultBrowserSource, /ms-settings:defaultapps\?registeredAppUser=/)
  assert.match(defaultBrowserSource, /shell\.openExternal\(focusedUri\)/)
  assert.match(defaultBrowserSource, /shell\.openExternal\('ms-settings:defaultapps'\)/)
})

test('electron-builder metadata registers only the custom Vast protocol', () => {
  const schemes = (packageJson.build?.protocols ?? []).flatMap((protocol) => protocol.schemes ?? [])
  assert.equal(schemes.includes('http'), false)
  assert.equal(schemes.includes('https'), false)
  const vastProtocol = packageJson.build?.protocols?.find((protocol) => protocol.schemes?.includes('vast'))
  assert.ok(vastProtocol)
  assert.deepEqual(vastProtocol.schemes, ['vast'])
})
