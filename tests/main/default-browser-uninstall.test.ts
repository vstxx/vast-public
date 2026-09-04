import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const installerNsh = readFileSync(new URL('../../build/installer.nsh', import.meta.url), 'utf8')
const defaultBrowserSource = readFileSync(new URL('../../src/main/default-browser.ts', import.meta.url), 'utf8')
const uninstallCommands = installerNsh
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith(';'))
  .join('\n')

test('NSIS uninstall removes only Vast-owned default-browser registration', () => {
  assert.match(installerNsh, /!macro\s+customInstall/)
  assert.match(installerNsh, /WriteRegNone\s+HKCU\s+"Software\\Classes\\\.pdf\\OpenWithProgids"\s+"VastPDF"/)
  assert.match(installerNsh, /Software\\Classes\\VastPDF\\shell\\open\\command/)
  assert.match(installerNsh, /!macro\s+customUnInstall/)
  assert.match(installerNsh, /DeleteRegValue\s+HKCU\s+"Software\\RegisteredApplications"\s+"Vast"/)
  assert.match(installerNsh, /DeleteRegKey\s+HKCU\s+"Software\\Clients\\StartMenuInternet\\Vast"/)
  assert.match(installerNsh, /DeleteRegKey\s+HKCU\s+"Software\\Classes\\VastHTML"/)
  assert.match(installerNsh, /DeleteRegValue\s+HKCU\s+"Software\\Classes\\\.pdf\\OpenWithProgids"\s+"VastPDF"/)
  assert.match(installerNsh, /DeleteRegKey\s+HKCU\s+"Software\\Classes\\VastPDF"/)
  assert.match(installerNsh, /DeleteRegKey\s+HKCU\s+"Software\\Classes\\Applications\\\$\{APP_EXECUTABLE_FILENAME\}"/)

  assert.doesNotMatch(uninstallCommands, /DeleteRegKey\s+HKCU\s+"Software\\Classes\\http"/i)
  assert.doesNotMatch(uninstallCommands, /DeleteRegKey\s+HKCU\s+"Software\\Classes\\https"/i)
  assert.doesNotMatch(uninstallCommands, /DeleteRegKey\s+HKCU\s+"Software\\Classes\\\.pdf"/i)
  assert.doesNotMatch(uninstallCommands, /UserChoice/i)
})

test('default-browser registration never writes generic protocol or UserChoice keys', () => {
  assert.doesNotMatch(defaultBrowserSource, /setAsDefaultProtocolClient/)
  assert.doesNotMatch(defaultBrowserSource, /Software\\Classes\\(?:http|https)(?:\\|['"])/i)
  assert.doesNotMatch(defaultBrowserSource, /UserChoice/i)
  assert.match(defaultBrowserSource, /Capabilities\\\\URLAssociations/)
  assert.match(defaultBrowserSource, /VastHTML/)
  assert.match(defaultBrowserSource, /distributionChannel === 'microsoft-store'/)
  assert.match(defaultBrowserSource, /ms-settings:defaultapps/)
})
